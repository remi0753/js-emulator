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
  return compileObject(ccSource(subpath), {
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

// Build a guest executable from a list of compiler source files plus the guest
// libc, startup, and runtime helpers.
function linkCompilerProgram(units: readonly string[]): Uint8Array {
  const objects: ObjectFile[] = [
    crt0Object(),
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
