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
import { compileObject, crt0Object, userCrtAssembly } from '../toolchain/cc.ts';
import { compile as chibiccCompile, type IncludeResolver } from '../toolchain/chibicc/index.ts';
import { I64_RUNTIME_SOURCE, i64RuntimeObject } from '../toolchain/chibicc/runtime64.ts';
import { floatRuntimeArchive } from '../toolchain/chibicc/runtimeFloat.ts';
import { linkObjects } from '../toolchain/object-linker.ts';
import { type Defines, GUEST_KERNEL_DEFINES, GUEST_KERNEL_LAYOUT } from './config.ts';
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

// Translation units the guest compiler rebuilds itself from. Each is plain C the
// guest `cc -S` turns into custom32 assembly named `<obj>.s`. These are *every*
// compiler translation unit — the vendored chibicc frontend, the custom32
// backend, the driver, the in-process linker, and the compiler support helpers.
const GUEST_SELFBUILD_UNITS: readonly { src: string; obj: string }[] = [
  { src: 'main.c', obj: 'main' },
  { src: 'guestlink.c', obj: 'guestlink' },
  { src: 'codegen.c', obj: 'codegen' },
  { src: 'ccsupport.c', obj: 'ccsupport' },
  { src: 'upstream/tokenize.c', obj: 'tokenize' },
  { src: 'upstream/preprocess.c', obj: 'preprocess' },
  { src: 'upstream/parse.c', obj: 'parse' },
  { src: 'upstream/type.c', obj: 'type' },
  { src: 'upstream/hashmap.c', obj: 'hashmap' },
  { src: 'upstream/strings.c', obj: 'strings' },
  { src: 'upstream/unicode.c', obj: 'unicode' },
];

// Prebuilt support assembly the guest links its freshly compiled objects
// against: the crt (startup + mem/str helpers), the guest libc, and the 64-bit
// runtime. This is toolchain support — provided the way a cross-compiler ships
// its target libc — so the guest compiles every compiler translation unit
// itself, then links them here. Produced with the bootstrap compiler's
// `compile()`, which emits the same assembly dialect the guest assembler reads.
function guestSupportAssembly(): { name: string; text: string }[] {
  const libcText = chibiccCompile(
    substituteDefines(userlandSource('libc.c'), GUEST_KERNEL_DEFINES),
    {
      name: 'libc.c',
      resolveInclude: resolveCompilerInclude,
    },
  );
  const i64Text = chibiccCompile(I64_RUNTIME_SOURCE, { name: 'i64rt.c' });
  return [
    { name: 'crt.s', text: userCrtAssembly(COMPILER_STACK_SIZE) },
    { name: 'libc.s', text: libcText },
    { name: 'i64rt.s', text: i64Text },
  ];
}

// The shell script the guest runs to rebuild the compiler from source: compile
// each translation unit to assembly, then link them with the support assembly
// into a fresh `cc` executable. One command per line (the guest shell has no
// `&&`); each `cc` runs in its own process so the frontend starts clean.
function guestBuildScript(output: string, scratch = '/b'): string {
  const lines = [`mkdir ${scratch}`];
  const total = GUEST_SELFBUILD_UNITS.length;
  GUEST_SELFBUILD_UNITS.forEach((unit, i) => {
    lines.push(`echo cc-build-unit ${i + 1}/${total} ${unit.src}`);
    lines.push(`cc -S -o ${scratch}/${unit.obj}.s /usr/src/cc/${unit.src}`);
  });
  lines.push('echo cc-build-link');
  lines.push(`cc -o ${output} @/usr/src/cc/link.objs`);
  lines.push('echo cc-build-done');
  return `${lines.join('\n')}\n`;
}

function guestLinkList(scratch = '/b'): string {
  const support = ['crt.s', 'libc.s', 'i64rt.s'].map((s) => `/usr/src/cc/${s}`);
  const objs = GUEST_SELFBUILD_UNITS.map((u) => `${scratch}/${u.obj}.s`);
  return `${[...support, ...objs].join('\n')}\n`;
}

// Output path the guest build script writes the rebuilt compiler to.
export const GUEST_REBUILT_CC_PATH = '/bin/cc2';
// Command that runs the in-guest compiler self-rebuild.
export const GUEST_BUILD_COMMAND = 'sh /usr/src/cc/build.sh';

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

// Global symbol name -> guest address for the built `/bin/cc`. Used only by
// development profiling to map sampled program counters back to functions.
export function chibiccCompilerSymbols(includeLocals = false): Map<string, number> {
  const objects: ObjectFile[] = [
    crt0Object(COMPILER_STACK_SIZE),
    ...COMPILER_UNITS.map(compileCc),
    compileCc('ccsupport.c'),
    compileLibc(),
    i64RuntimeObject(),
  ];
  return linkObjects(objects, [floatRuntimeArchive()], {
    textOrigin: GUEST_KERNEL_LAYOUT.userLoadBase,
    entry: '_start',
    includeLocals,
  }).symbols;
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
  // Headers the compiler/libc sources reach through `#include` but that are not
  // in the lists above: the userland libc surface (pulled in by stdio.h etc.)
  // and the compiler support helpers (pulled in by chibicc.h from upstream/).
  // The guest `cc` (upstream frontend built by the bootstrap backend) cannot yet
  // parse function-pointer declarators, so degrade `sighandler_t` to a plain
  // pointer here — the compiler never references signal()/sigaction(), and the
  // prebuilt libc.s keeps the real definitions, so the symbols still link.
  fs.writeFile(
    '/include/libc.h',
    new TextEncoder().encode(
      substituteDefines(userlandSource('libc.h'), GUEST_KERNEL_DEFINES).replace(
        'typedef void (*sighandler_t)(int signal);',
        'typedef void *sighandler_t;',
      ),
    ),
  );
  fs.writeFile('/include/ccsupport.h', new TextEncoder().encode(ccSource('ccsupport.h')));
  if (options.installSources) installChibiccSources(fs, options.sourceRoot);
}

export function installChibiccSources(fs: Fs, root = '/usr/src/cc'): void {
  const enc = new TextEncoder();
  // Substitute the kernel config tokens (CFG_USER_LOAD_BASE, CFG_EXEC_MAGIC, …)
  // into the source before staging it, exactly as the host compile path does
  // (compileObject). The guest `cc` has no -D mechanism for these, so without
  // substitution guestlink.c's `CFG_USER_LOAD_BASE` reaches the guest as a bare
  // identifier and fails to compile ("undefined variable").
  const src = (subpath: string) => substituteDefines(ccSource(subpath), GUEST_KERNEL_DEFINES);
  for (const source of COMPILER_SOURCE_FILES) {
    fs.writeFile(`${root}/${source}`, enc.encode(src(source)));
  }
  fs.writeFile(`${root}/chibicc.h`, enc.encode(src('upstream/chibicc.h')));
  // ccsupport.h is reached relative to upstream/chibicc.h; mirror it there too.
  fs.writeFile(`${root}/upstream/ccsupport.h`, enc.encode(src('ccsupport.h')));
  fs.writeFile(`${root}/selfhost.c`, enc.encode(SELFHOST_PROBE_SOURCE));

  // The self-rebuild kit: prebuilt support assembly, the link list, and the
  // build script the guest runs to recompile the whole compiler into /bin/cc2.
  for (const support of guestSupportAssembly())
    fs.writeFile(`${root}/${support.name}`, enc.encode(support.text));
  fs.writeFile(`${root}/link.objs`, enc.encode(guestLinkList()));
  fs.writeFile(`${root}/build.sh`, enc.encode(guestBuildScript(GUEST_REBUILT_CC_PATH)));
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
