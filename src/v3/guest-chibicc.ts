// Build glue for the guest-native C compiler (Phase 34).
//
// The maintained host compiler is the TypeScript chibicc port in
// `src/toolchain/chibicc/`. This module instead cross-compiles the *C-source*
// chibicc frontend (vendored from upstream in `src/toolchain/cc-c/upstream/`,
// MIT, Rui Ueyama) together with a local custom32 backend into a guest
// executable, so a real C compiler can run inside the OS. The cross-compiler
// used for that build is the TS chibicc port itself — it is the bootstrap stage.
//
// This is the guest-specific boundary (load base, libc, include search) that
// keeps `src/toolchain/` independent of any one OS generation, mirroring
// `guest-cc.ts` and `guest-kernel.ts`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ObjectFile } from '../formats/object.ts';
import type { Fs } from '../storage/fs.ts';
import { compileObject, crt0Object } from '../toolchain/cc.ts';
import type { IncludeResolver } from '../toolchain/chibicc/index.ts';
import { i64RuntimeObject } from '../toolchain/chibicc/runtime64.ts';
import { floatRuntimeArchive } from '../toolchain/chibicc/runtimeFloat.ts';
import { type Defines, GUEST_KERNEL_DEFINES } from './config.ts';
import { linkGuestExecutable } from './guest-cc.ts';

// Read a file from the compiler source tree (`src/toolchain/cc-c/...`).
const ccSource = (subpath: string): string =>
  readFileSync(fileURLToPath(new URL(`../toolchain/cc-c/${subpath}`, import.meta.url)), 'utf8');

// Read a file from the guest userland tree (`src/v3/userland/...`) — the guest
// libc the compiler links against and its system headers.
const userlandSource = (subpath: string): string =>
  readFileSync(fileURLToPath(new URL(`./userland/${subpath}`, import.meta.url)), 'utf8');

function substituteDefines(source: string, defines: Defines): string {
  for (const key of Object.keys(defines).sort((a, b) => b.length - a.length)) {
    source = source.replace(new RegExp(`\\b${key}\\b`, 'g'), String(defines[key]));
  }
  return source;
}

// Header search for `#include`: the vendored frontend root (chibicc.h,
// ccsupport.h, the local backend), then the freestanding compat headers, then
// the guest libc headers. Guest libc files carry the kernel config tokens, so
// they get define substitution; the vendored frontend does not.
const resolveCompilerInclude: IncludeResolver = (name) => {
  for (const base of ['', 'upstream/', 'include/']) {
    try {
      return { path: `cc-c/${base}${name}`, text: ccSource(`${base}${name}`) };
    } catch {
      // try next search root
    }
  }
  try {
    return {
      path: `userland/${name}`,
      text: substituteDefines(userlandSource(name), GUEST_KERNEL_DEFINES),
    };
  } catch {
    return undefined;
  }
};

function compileCc(subpath: string): ObjectFile {
  return compileObject(substituteDefines(ccSource(subpath), GUEST_KERNEL_DEFINES), {
    name: `${subpath.replace(/[/.]/g, '_')}.o`,
    resolveInclude: resolveCompilerInclude,
  });
}

function compileLibc(): ObjectFile {
  return compileObject(substituteDefines(userlandSource('libc.c'), GUEST_KERNEL_DEFINES), {
    name: 'libc.o',
    resolveInclude: resolveCompilerInclude,
  });
}

// The vendored chibicc frontend translation units reused as-is (codegen.c is
// replaced by the local custom32 backend; main.c by the local guest driver).
const FRONTEND_UNITS = [
  'upstream/tokenize.c',
  'upstream/hashmap.c',
  'upstream/strings.c',
  'upstream/unicode.c',
  'upstream/type.c',
] as const;

// Every vendored chibicc frontend translation unit (codegen.c and main.c are
// replaced by the guest backend and driver). All of these cross-compile with
// the TS bootstrap frontend and link into the guest-native compiler.
const ALL_FRONTEND_UNITS = [
  'upstream/tokenize.c',
  'upstream/preprocess.c',
  'upstream/parse.c',
  'upstream/type.c',
  'upstream/hashmap.c',
  'upstream/strings.c',
  'upstream/unicode.c',
] as const;

const COMPILER_UNITS = ['main.c', 'guestlink.c', ...ALL_FRONTEND_UNITS, 'codegen.c'] as const;

const COMPILER_SUPPORT_FILES = ['ccsupport.c', 'ccsupport.h', 'guestlink.h'] as const;

const COMPILER_HEADERS = [
  'include/assert.h',
  'include/glob.h',
  'include/libgen.h',
  'include/stdbool.h',
  'include/stdarg.h',
  'include/stdnoreturn.h',
  'include/strings.h',
  'include/sys/stat.h',
  'include/sys/types.h',
  'include/sys/wait.h',
  'include/time.h',
] as const;

const COMPILER_SOURCE_FILES = [
  ...COMPILER_UNITS,
  ...COMPILER_SUPPORT_FILES,
  'upstream/chibicc.h',
] as const;

const USERLAND_HEADERS = [
  'stddef.h',
  'stdint.h',
  'limits.h',
  'errno.h',
  'stdio.h',
  'stdlib.h',
  'string.h',
  'ctype.h',
  'fcntl.h',
  'unistd.h',
  'sys/stat.h',
] as const;

const COMPILER_STACK_SIZE = 256 * 1024;

const SELFHOST_PROBE_SOURCE = [
  'struct cc_type { int kind; int size; int align; };',
  '',
  'int cc_selfhost_align(int n, int align) {',
  '  return (n + align - 1) / align * align;',
  '}',
  '',
  'int cc_selfhost_probe(struct cc_type *ty, int x) {',
  '  return cc_selfhost_align(x + ty->size, ty->align);',
  '}',
  '',
].join('\n');

// Compile every vendored frontend translation unit to a relocatable object,
// proving the real chibicc C frontend cross-compiles under the bootstrap
// compiler. Throws if any unit fails to compile.
export function compileChibiccFrontend(): ObjectFile[] {
  return ALL_FRONTEND_UNITS.map(compileCc);
}

// Compile the local custom32 backend (`cc-c/codegen.c`, a C port of the
// maintained `src/toolchain/chibicc/codegen.ts`) to a relocatable object. This
// is the target-specific half of the guest compiler, standing in for upstream's
// x86-64 codegen.c. Throws if it fails to compile.
export function compileGuestBackend(): ObjectFile {
  return compileCc('codegen.c');
}

// Build a guest executable from a list of compiler source files plus the guest
// libc, startup, and runtime helpers.
function linkCompilerProgram(units: readonly string[]): Uint8Array {
  const objects: ObjectFile[] = [
    crt0Object(COMPILER_STACK_SIZE),
    ...units.map(compileCc),
    compileCc('ccsupport.c'),
    compileLibc(),
    i64RuntimeObject(),
  ];
  return linkGuestExecutable(objects, [floatRuntimeArchive()]);
}

// Phase 34 de-risking probe: the vendored chibicc tokenizer compiled to a guest
// executable. Proves the real frontend cross-compiles and runs in the guest
// before the codegen.c port is written.
export function buildChibiccProbe(): Uint8Array {
  return linkCompilerProgram(['probe.c', ...FRONTEND_UNITS]);
}

// Build the guest-native `cc` executable: vendored chibicc frontend, local
// custom32 backend, and the freestanding driver in `cc-c/main.c`.
export function buildChibiccCompiler(): Uint8Array {
  return linkCompilerProgram(COMPILER_UNITS);
}

export interface InstallChibiccOptions {
  path?: string;
  installSources?: boolean;
  sourceRoot?: string;
}

// Install the guest compiler and the headers it can search at `/include`.
// The compiler supports `-S` assembly output and its default mode assembles and
// links a single source file into a guest executable in-process.
export function installChibiccToolchain(fs: Fs, options: InstallChibiccOptions = {}): void {
  const path = options.path ?? '/bin/cc';
  fs.writeFile(path, buildChibiccCompiler());
  fs.chmod(path, 0o755);
  for (const header of USERLAND_HEADERS) {
    fs.writeFile(
      `/include/${header}`,
      new TextEncoder().encode(substituteDefines(userlandSource(header), GUEST_KERNEL_DEFINES)),
    );
  }
  for (const header of COMPILER_HEADERS) {
    fs.writeFile(
      `/include/${header.replace(/^include\//, '')}`,
      new TextEncoder().encode(ccSource(header)),
    );
  }
  if (options.installSources) installChibiccSources(fs, options.sourceRoot);
}

export function installChibiccSources(fs: Fs, root = '/usr/src/cc'): void {
  const enc = new TextEncoder();
  for (const source of COMPILER_SOURCE_FILES) {
    fs.writeFile(`${root}/${source}`, enc.encode(ccSource(source)));
  }
  fs.writeFile(`${root}/chibicc.h`, enc.encode(ccSource('upstream/chibicc.h')));
  fs.writeFile(`${root}/selfhost.c`, enc.encode(SELFHOST_PROBE_SOURCE));
  fs.writeFile(
    `${root}/README`,
    enc.encode(
      [
        'custom32 guest compiler bootstrap source bundle',
        '',
        'These files are the exact C inputs used by the host bootstrap stage to',
        'build /bin/cc. Phase 35 tests compile a selfhost probe from this tree',
        'inside the guest and compare repeated stage outputs for deterministic',
        'replay.',
        '',
        'Current guest cc limits: no -c relocatable output, no multi-input link,',
        'and no standalone guest as/ld yet. The package failure queue is tracked',
        'in docs/phase35-package-queue.md in the host repository.',
        '',
      ].join('\n'),
    ),
  );
}
