// custom32-cc driver core: compile C, assemble, and link into a guest
// executable through the relocatable object format.
//
// This is the object-file counterpart to `guest-kernel.ts`'s `buildUserExecutable`,
// which links `CompiledObject`s directly with the source-level `linker.ts`. Here a
// C translation unit is lowered to a relocatable `ObjectFile` (via the same
// `as.ts` assembler the `.s` path uses) so C, hand-written assembly, objects, and
// static archives all link through one pipeline (`object-linker.ts`) and the
// guest loader header is emitted by `flattenGuestExecutable`.
//
// To avoid every C object carrying its own startup/runtime (which would collide
// at link time on `_start`, `__csp`, `memcpy`, ...), translation units are
// compiled with no startup and no runtime, and a single shared `crt0Object()`
// provides `_start`, the software-stack symbols, `environ`, and the runtime
// helpers. Each TU references those as undefined symbols, resolved at link.

import type { Archive } from '../formats/archive.ts';
import { encodeExecutable } from '../formats/executable.ts';
import type { ObjectFile } from '../formats/object.ts';
import { assembleObject } from './as.ts';
import { type CompiledObject, compileC } from './c.ts';
import { flattenGuestExecutable, linkObjects } from './object-linker.ts';

// Generic relocatable text origin when no target layout is supplied. Guest
// callers override this with the OS load base (see src/v3/guest-cc.ts); keeping
// the OS-specific addresses out of this module preserves the toolchain's
// independence from any one OS generation.
const DEFAULT_TEXT_ORIGIN = 0x1000;

// Startup and runtime symbols the shared crt0 object owns. Translation units
// reference these but never define them, so they resolve to the single crt0
// copy at link time instead of producing duplicate-symbol errors.
const CRT0_TEXT_EXPORTS = new Set(['_start', 'memcpy', 'memset', 'strlen', 'strcmp']);
const CRT0_DATA_EXPORTS = new Set(['__csp', '__stack', 'environ']);

export interface CompileObjectOptions {
  // Object module name (for diagnostics / dump output).
  name?: string;
  // Namespaces compiler-generated local labels; defaults to the name. Several C
  // objects must use distinct ids so their private labels do not collide.
  moduleId?: string | number;
}

// Compile one C translation unit into a relocatable object. The unit carries no
// startup code and no runtime helpers; link it with `crt0Object()`.
export function compileObject(source: string, options: CompileObjectOptions = {}): ObjectFile {
  const name = options.name ?? 'a.o';
  const co = compileC(source, {
    start: 'none',
    includeRuntime: false,
    moduleId: options.moduleId ?? name,
  });
  return lowerToObject(co, {
    name,
    // Defined functions are exported so other units can call them.
    textExports: new Set(co.sourceMap.keys()),
    // Non-extern globals (those that actually have storage here) are exported;
    // string literals and the shared stack symbols are not.
    isExportedData: (sym) => co.globals.has(sym),
    // The shared software stack / environ live in crt0; never duplicate them.
    exclude: CRT0_DATA_EXPORTS,
  });
}

// The single shared startup + runtime object: `_start`, the C software stack
// (`__csp`/`__stack`), `environ`, and the `memcpy`/`memset`/`strlen`/`strcmp`
// helpers. `_start` (start kind `user`) reads argc/argv/envp from the exec ABI,
// publishes `environ`, calls `main`, and exits with its return value.
export function crt0Object(): ObjectFile {
  const co = compileC('', { start: 'user', includeRuntime: true, moduleId: 'crt0' });
  return lowerToObject(co, {
    name: 'crt0.o',
    textExports: CRT0_TEXT_EXPORTS,
    isExportedData: (sym) => CRT0_DATA_EXPORTS.has(sym),
    exclude: new Set(),
  });
}

interface LowerOptions {
  name: string;
  // Defined text labels to export as global symbols.
  textExports: Set<string>;
  // Whether a defined data/bss symbol should be exported as a global symbol.
  isExportedData: (sym: string) => boolean;
  // Data/bss symbols to omit entirely (provided by another object).
  exclude: Set<string>;
}

// Lower a `CompiledObject` (assembly text + data/bss symbol tables) into a
// relocatable object by re-emitting it as assembler source and running the same
// `as.ts` assembler the `.s` path uses. The assembler turns every bare-identifier
// operand into an `abs32` relocation, so cross-object references resolve at link.
function lowerToObject(co: CompiledObject, opts: LowerOptions): ObjectFile {
  const lines: string[] = [];
  for (const sym of opts.textExports) lines.push(`.global ${sym}`);

  lines.push('.text');
  if (co.text.trim() !== '') lines.push(co.text);

  const data = co.data.filter((d) => !opts.exclude.has(d.name));
  if (data.length > 0) {
    lines.push('.data');
    for (const sym of data) {
      if (opts.isExportedData(sym.name)) lines.push(`.global ${sym.name}`);
      lines.push(`${sym.name}:`);
      emitDataBytes(lines, sym.bytes, sym.relocs ?? []);
      if (sym.size > sym.bytes.length) lines.push(`  .space ${sym.size - sym.bytes.length}`);
    }
  }

  const bss = co.bss.filter((b) => !opts.exclude.has(b.name));
  if (bss.length > 0) {
    lines.push('.bss');
    for (const sym of bss) {
      if (opts.isExportedData(sym.name)) lines.push(`.global ${sym.name}`);
      lines.push(`${sym.name}:`);
      lines.push(`  .space ${sym.size}`);
    }
  }

  return assembleObject(lines.join('\n'), opts.name);
}

// Emit a data symbol's initialized bytes as `.byte`/`.word` directives. A 4-byte
// relocation (e.g. a pointer global pointing at a string literal or another
// global) becomes `.word target` so the assembler records an `abs32` relocation;
// every other run of bytes becomes `.byte` literals.
function emitDataBytes(
  lines: string[],
  bytes: Uint8Array,
  relocs: { offset: number; target: string }[],
): void {
  const sorted = [...relocs].sort((a, b) => a.offset - b.offset);
  let i = 0;
  let r = 0;
  while (i < bytes.length) {
    if (r < sorted.length && sorted[r]!.offset === i) {
      lines.push(`  .word ${sorted[r]!.target}`);
      i += 4;
      r++;
      continue;
    }
    const next = r < sorted.length ? sorted[r]!.offset : bytes.length;
    const chunk: number[] = [];
    while (i < next) chunk.push(bytes[i++]!);
    // Wrap long runs so directive lines stay readable.
    for (let k = 0; k < chunk.length; k += 16) {
      lines.push(`  .byte ${chunk.slice(k, k + 16).join(',')}`);
    }
  }
}

export type LinkFormat = 'guest' | 'raw';

export interface LinkOptions {
  entry?: string;
  textOrigin?: number;
  format?: LinkFormat;
  // Loadable-header magic for the `guest` format (required when format is
  // `guest`); ignored for `raw`. Supplied by the OS-aware caller so this module
  // stays independent of any one OS generation's constants.
  magic?: number;
}

// Link objects + archives into an executable image. `guest` emits the loadable
// header the guest exec path consumes (12-byte magic/entry/memSize header at
// `textOrigin`); `raw` (the default) emits the generic JEX container.
export function linkExecutableImage(
  objects: ObjectFile[],
  archives: Archive[] = [],
  options: LinkOptions = {},
): Uint8Array {
  const format = options.format ?? 'raw';
  const textOrigin = options.textOrigin ?? DEFAULT_TEXT_ORIGIN;
  const linked = linkObjects(objects, archives, {
    entry: options.entry ?? '_start',
    textOrigin,
  });
  if (format === 'raw') return encodeExecutable(linked.executable);
  if (options.magic === undefined) {
    throw new Error('linkExecutableImage: guest format requires a magic value');
  }
  return flattenGuestExecutable(linked, textOrigin, options.magic);
}
