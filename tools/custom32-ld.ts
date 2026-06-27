#!/usr/bin/env node
// custom32-ld: link objects and archives into an executable.
//
// Usage: custom32-ld [-o out] [-e entry] [--format guest|raw]
//                    [--text-origin N] [-L dir] [-l name] inputs...
//
// Inputs are object files (always linked) and archives (members are pulled on
// demand). Archives can be named positionally (foo.a) or via `-lfoo` searched
// across `-L` directories and the current directory. The default `guest` format
// emits the loadable header the guest exec path consumes; `raw` emits the
// generic JEX executable container.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Archive, isArchive, parseArchive } from '../src/formats/archive.ts';
import { encodeExecutable } from '../src/formats/executable.ts';
import { isObject, type ObjectFile, parseObject } from '../src/formats/object.ts';
import { flattenGuestExecutable, linkObjects } from '../src/toolchain/object-linker.ts';
import { GUEST_EXECUTABLE_MAGIC, GUEST_KERNEL_LAYOUT } from '../src/v3/config.ts';

function fail(message: string): never {
  console.error(`custom32-ld: ${message}`);
  process.exit(1);
}

function parseInt32(value: string): number {
  const n = value.startsWith('0x') ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) fail(`invalid number: ${value}`);
  return n;
}

function main(argv: string[]): void {
  let out = 'a.out';
  let entry = '_start';
  let format: 'guest' | 'raw' = 'guest';
  let textOrigin: number | undefined;
  const libDirs: string[] = ['.'];
  const libNames: string[] = [];
  const inputs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-o') out = argv[++i] ?? fail('-o requires an argument');
    else if (arg === '-e' || arg === '--entry')
      entry = argv[++i] ?? fail('-e requires an argument');
    else if (arg === '--format') {
      const value = argv[++i];
      if (value !== 'guest' && value !== 'raw') fail('--format must be guest or raw');
      format = value;
    } else if (arg === '--text-origin')
      textOrigin = parseInt32(argv[++i] ?? fail('--text-origin requires an argument'));
    else if (arg === '-L') libDirs.push(argv[++i] ?? fail('-L requires an argument'));
    else if (arg.startsWith('-L')) libDirs.push(arg.slice(2));
    else if (arg === '-l') libNames.push(argv[++i] ?? fail('-l requires an argument'));
    else if (arg.startsWith('-l')) libNames.push(arg.slice(2));
    else if (arg === '-h' || arg === '--help') {
      console.log(
        'usage: custom32-ld [-o out] [-e entry] [--format guest|raw] [-L dir] [-l name] inputs...',
      );
      return;
    } else if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
    else inputs.push(arg);
  }

  const objects: ObjectFile[] = [];
  const archives: Archive[] = [];
  for (const path of inputs) {
    const bytes = new Uint8Array(readFileSync(path));
    if (isArchive(bytes)) archives.push(parseArchive(bytes));
    else if (isObject(bytes)) objects.push(parseObject(bytes));
    else fail(`unrecognized input file: ${path}`);
  }
  for (const name of libNames) {
    const path = libDirs.map((dir) => join(dir, `lib${name}.a`)).find((p) => existsSync(p));
    if (path === undefined) fail(`cannot find -l${name}`);
    archives.push(parseArchive(new Uint8Array(readFileSync(path))));
  }

  if (objects.length === 0) fail('no object files to link');

  const defaultOrigin = format === 'guest' ? GUEST_KERNEL_LAYOUT.userLoadBase : 0x1000;
  let linked: ReturnType<typeof linkObjects>;
  try {
    linked = linkObjects(objects, archives, { entry, textOrigin: textOrigin ?? defaultOrigin });
  } catch (error) {
    fail((error as Error).message);
  }

  const bytes =
    format === 'guest'
      ? flattenGuestExecutable(
          linked,
          textOrigin ?? GUEST_KERNEL_LAYOUT.userLoadBase,
          GUEST_EXECUTABLE_MAGIC,
        )
      : encodeExecutable(linked.executable);
  writeFileSync(out, bytes);
}

main(process.argv.slice(2));
