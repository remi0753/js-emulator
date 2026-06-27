#!/usr/bin/env node
// custom32-cc: a host C driver for the custom32 guest target.
//
// It ties the toolchain stages together — compile C, assemble, link against
// objects and static archives, and optionally install the result into a disk
// image — the way `cc` does. The current TypeScript C-like compiler is the
// bootstrap frontend; the pipeline below stays the same when a real frontend
// replaces it.
//
// Usage:
//   custom32-cc [options] inputs...
//
// Inputs by extension: `.c` compiled, `.s` assembled, `.o` objects, `.a`
// archives (members pulled on demand). Options:
//   -o out            output path (executable, or the single -c object)
//   -c                compile/assemble only; emit one .o per input, do not link
//   -e, --entry NAME  entry symbol (default _start)
//   --format f        guest (default) or raw executable container
//   --text-origin N   override the text load address
//   -L dir / -l name  archive search path / link libNAME.a
//   -nostartfiles     do not link the built-in crt0 startup/runtime object
//   --frontend F      C frontend: bootstrap (default) or chibicc
//   --install IMG     install the linked executable into disk image IMG
//   --install-as PATH guest path for --install (default /bin/<output name>)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { type Archive, isArchive, parseArchive } from '../src/formats/archive.ts';
import { encodeObject, isObject, type ObjectFile, parseObject } from '../src/formats/object.ts';
import { assembleObject } from '../src/toolchain/as.ts';
import {
  compileObject,
  crt0Object,
  type LinkFormat,
  linkExecutableImage,
} from '../src/toolchain/cc.ts';
import { compileObject as chibiccCompileObject } from '../src/toolchain/chibicc/index.ts';
import { installExecutable, linkGuestExecutable } from '../src/v3/guest-cc.ts';

type Frontend = 'bootstrap' | 'chibicc';

function fail(message: string): never {
  console.error(`custom32-cc: ${message}`);
  process.exit(1);
}

function parseInt32(value: string): number {
  const n = value.startsWith('0x') ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) fail(`invalid number: ${value}`);
  return n;
}

function objectOutPath(input: string): string {
  return `${input.replace(/\.[^.]+$/, '')}.o`;
}

function main(argv: string[]): void {
  let out: string | undefined;
  let compileOnly = false;
  let entry = '_start';
  let format: LinkFormat = 'guest';
  let textOrigin: number | undefined;
  let noStartFiles = false;
  let frontend: Frontend = 'bootstrap';
  let installImage: string | undefined;
  let installAs: string | undefined;
  const libDirs: string[] = ['.'];
  const libNames: string[] = [];
  const inputs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-o') out = argv[++i] ?? fail('-o requires an argument');
    else if (arg === '-c') compileOnly = true;
    else if (arg === '-e' || arg === '--entry')
      entry = argv[++i] ?? fail('-e requires an argument');
    else if (arg === '--format') {
      const value = argv[++i];
      if (value !== 'guest' && value !== 'raw') fail('--format must be guest or raw');
      format = value;
    } else if (arg === '--text-origin')
      textOrigin = parseInt32(argv[++i] ?? fail('--text-origin requires an argument'));
    else if (arg === '-nostartfiles' || arg === '--nostartfiles') noStartFiles = true;
    else if (arg === '--frontend') {
      const value = argv[++i];
      if (value !== 'bootstrap' && value !== 'chibicc')
        fail('--frontend must be bootstrap or chibicc');
      frontend = value;
    } else if (arg === '--install')
      installImage = argv[++i] ?? fail('--install requires an argument');
    else if (arg === '--install-as')
      installAs = argv[++i] ?? fail('--install-as requires an argument');
    else if (arg === '-L') libDirs.push(argv[++i] ?? fail('-L requires an argument'));
    else if (arg.startsWith('-L')) libDirs.push(arg.slice(2));
    else if (arg === '-l') libNames.push(argv[++i] ?? fail('-l requires an argument'));
    else if (arg.startsWith('-l')) libNames.push(arg.slice(2));
    else if (arg === '-h' || arg === '--help') {
      console.log('usage: custom32-cc [options] inputs...  (see header for options)');
      return;
    } else if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
    else inputs.push(arg);
  }

  if (inputs.length === 0) fail('no input files');

  // Stage 1: lower each input to an object (or pass archives through).
  const objects: ObjectFile[] = [];
  const archives: Archive[] = [];
  const emittedObjects: { input: string; obj: ObjectFile }[] = [];
  for (const path of inputs) {
    if (path.endsWith('.c')) {
      const source = readFileSync(path, 'utf8');
      const name = objectOutPath(basename(path));
      const obj =
        frontend === 'chibicc'
          ? chibiccCompileObject(source, { name })
          : compileObject(source, { name, moduleId: basename(path) });
      objects.push(obj);
      emittedObjects.push({ input: path, obj });
    } else if (path.endsWith('.s') || path.endsWith('.asm')) {
      const obj = assembleObject(readFileSync(path, 'utf8'), objectOutPath(basename(path)));
      objects.push(obj);
      emittedObjects.push({ input: path, obj });
    } else {
      const bytes = new Uint8Array(readFileSync(path));
      if (isArchive(bytes)) archives.push(parseArchive(bytes));
      else if (isObject(bytes)) objects.push(parseObject(bytes));
      else fail(`unrecognized input file: ${path}`);
    }
  }

  // -c stops after producing objects.
  if (compileOnly) {
    if (out !== undefined && emittedObjects.length > 1)
      fail('-o with -c requires a single input file');
    for (const { input, obj } of emittedObjects) {
      writeFileSync(out ?? objectOutPath(input), encodeObject(obj));
    }
    return;
  }

  for (const name of libNames) {
    const path = libDirs.map((dir) => join(dir, `lib${name}.a`)).find((p) => existsSync(p));
    if (path === undefined) fail(`cannot find -l${name}`);
    archives.push(parseArchive(new Uint8Array(readFileSync(path))));
  }

  // Stage 2: link. crt0 (startup + runtime) is linked first unless suppressed.
  const linkInputs = noStartFiles ? objects : [crt0Object(), ...objects];
  if (linkInputs.length === 0) fail('no objects to link');

  let exe: Uint8Array;
  try {
    exe =
      format === 'guest'
        ? linkGuestExecutable(linkInputs, archives, { entry, textOrigin })
        : linkExecutableImage(linkInputs, archives, { entry, format, textOrigin });
  } catch (error) {
    fail((error as Error).message);
  }

  const outPath = out ?? 'a.out';
  writeFileSync(outPath, exe);

  // Stage 3: optional install into a disk image.
  if (installImage !== undefined) {
    const guestPath = installAs ?? `/bin/${basename(outPath)}`;
    const image = installExecutable(new Uint8Array(readFileSync(installImage)), guestPath, exe);
    writeFileSync(installImage, image);
  }
}

main(process.argv.slice(2));
