// custom32-cc driver core: compile C with the chibicc-derived frontend,
// assemble, and link relocatable objects into executable images.
//
// C translation units carry no startup code and no runtime helpers. A single
// shared crt0 object provides `_start`, the software-stack symbols, `environ`,
// and the small memory/string helpers required by generated code.

import type { Archive } from '../formats/archive.ts';
import { encodeExecutable } from '../formats/executable.ts';
import type { ObjectFile } from '../formats/object.ts';
import { assembleObject } from './as.ts';
import {
  type CompileOptions as ChibiccCompileOptions,
  compileObject as chibiccCompileObject,
} from './chibicc/index.ts';
import { flattenGuestExecutable, linkObjects } from './object-linker.ts';

// Generic relocatable text origin when no target layout is supplied. Guest
// callers override this with the OS load base (see src/v3/guest-cc.ts); keeping
// the OS-specific addresses out of this module preserves the toolchain's
// independence from any one OS generation.
const DEFAULT_TEXT_ORIGIN = 0x1000;

export interface CompileObjectOptions {
  // Object module name (for diagnostics / dump output).
  name?: string;
  // Retained for compatibility with the bootstrap compiler driver. chibicc
  // generates translation-unit-local labels internally and does not need it.
  moduleId?: string | number;
  // Resolves `#include` directives.
  resolveInclude?: ChibiccCompileOptions['resolveInclude'];
}

// Compile one C translation unit into a relocatable object. The unit carries no
// startup code and no runtime helpers; link it with `crt0Object()`.
export function compileObject(source: string, options: CompileObjectOptions = {}): ObjectFile {
  return chibiccCompileObject(source, {
    name: options.name ?? 'a.o',
    resolveInclude: options.resolveInclude,
  });
}

// The single shared startup + runtime object: `_start`, the C software stack
// (`__csp`/`__stack`), `environ`, and the `memcpy`/`memset`/`strlen`/`strcmp`
// helpers. `_start` (start kind `user`) reads argc/argv/envp from the exec ABI,
// publishes `environ`, calls `main`, and exits with its return value.
export function crt0Object(stackSize = 4096): ObjectFile {
  return assembleObject(`${userStartAssembly()}\n${runtimeAssembly(stackSize)}`, 'crt0.o');
}

// Startup for the privileged guest kernel. The VM supplies the hardware stack;
// this initializes the C software stack, calls kmain, and halts if it returns.
export function kernelCrt0Object(stackSize = 8192): ObjectFile {
  return assembleObject(`${kernelStartAssembly()}\n${runtimeAssembly(stackSize)}`, 'kcrt0.o');
}

// The user crt as raw assembly text: `_start`, the C software stack, `environ`,
// and the `memcpy`/`memset`/`strlen`/`strcmp` helpers. Used by the guest-native
// linker (which assembles this directly) so it shares the host crt definition.
export function userCrtAssembly(stackSize = 4096): string {
  return `${userStartAssembly()}\n${runtimeAssembly(stackSize)}`;
}

function userStartAssembly(): string {
  return `
.global _start
.text
_start:
  MOV R5, __stack
  STORE R5, __csp
  STORE R2, environ
  LOAD R5, __csp
  STORER R5, R1
  MOV R7, 4
  ADD R5, R7
  STORE R5, __csp
  LOAD R5, __csp
  STORER R5, R0
  MOV R7, 4
  ADD R5, R7
  STORE R5, __csp
  CALL main
  LOAD R5, __csp
  MOV R7, 8
  SUB R5, R7
  STORE R5, __csp
  MOVR R1, R0
  MOV R0, 0
  INT 128
`;
}

function kernelStartAssembly(): string {
  return `
.global _start
.text
_start:
  MOV R5, __stack
  STORE R5, __csp
  CALL kmain
  HLT
`;
}

function runtimeAssembly(stackSize: number): string {
  return `
.global memcpy, memset, strlen, strcmp
.global __csp, __stack, environ
.text
memcpy:
  PUSH R6
  LOAD R6, __csp
  MOVR R1, R6
  MOV R7, 4
  SUB R1, R7
  LOADR R2, R1
  MOVR R1, R6
  MOV R7, 8
  SUB R1, R7
  LOADR R3, R1
  MOVR R1, R6
  MOV R7, 12
  SUB R1, R7
  LOADR R4, R1
  MOVR R0, R2
  MOV R7, 4
  MOV R1, 16
memcpy_chunk:
  CMP R4, R1
  JL memcpy_word
  LOADR R5, R3
  STORER R2, R5
  ADD R3, R7
  ADD R2, R7
  LOADR R5, R3
  STORER R2, R5
  ADD R3, R7
  ADD R2, R7
  LOADR R5, R3
  STORER R2, R5
  ADD R3, R7
  ADD R2, R7
  LOADR R5, R3
  STORER R2, R5
  ADD R3, R7
  ADD R2, R7
  SUB R4, R1
  JMP memcpy_chunk
memcpy_word:
  CMP R4, R7
  JL memcpy_byte
  LOADR R5, R3
  STORER R2, R5
  ADD R2, R7
  ADD R3, R7
  SUB R4, R7
  JMP memcpy_word
memcpy_byte:
  MOV R7, 0
  CMP R4, R7
  JZ memcpy_done
  LB R5, R3
  SB R2, R5
  INC R2
  INC R3
  DEC R4
  JMP memcpy_byte
memcpy_done:
  STORE R6, __csp
  POP R6
  RET

memset:
  PUSH R6
  LOAD R6, __csp
  MOVR R1, R6
  MOV R7, 4
  SUB R1, R7
  LOADR R2, R1
  MOVR R1, R6
  MOV R7, 8
  SUB R1, R7
  LOADR R3, R1
  MOVR R1, R6
  MOV R7, 12
  SUB R1, R7
  LOADR R4, R1
  MOVR R0, R2
  MOV R7, 255
  AND R3, R7
  MOV R7, 16843009
  MOVR R5, R3
  MUL R5, R7
  MOV R7, 4
  MOV R1, 16
memset_chunk:
  CMP R4, R1
  JL memset_word
  STORER R2, R5
  ADD R2, R7
  STORER R2, R5
  ADD R2, R7
  STORER R2, R5
  ADD R2, R7
  STORER R2, R5
  ADD R2, R7
  SUB R4, R1
  JMP memset_chunk
memset_word:
  CMP R4, R7
  JL memset_byte
  STORER R2, R5
  ADD R2, R7
  SUB R4, R7
  JMP memset_word
memset_byte:
  MOV R7, 0
  CMP R4, R7
  JZ memset_done
  SB R2, R3
  INC R2
  DEC R4
  JMP memset_byte
memset_done:
  STORE R6, __csp
  POP R6
  RET

strlen:
  PUSH R6
  LOAD R6, __csp
  MOVR R1, R6
  MOV R7, 4
  SUB R1, R7
  LOADR R2, R1
  MOV R0, 0
strlen_loop:
  LB R3, R2
  MOV R7, 0
  CMP R3, R7
  JZ strlen_done
  INC R0
  INC R2
  JMP strlen_loop
strlen_done:
  STORE R6, __csp
  POP R6
  RET

strcmp:
  PUSH R6
  LOAD R6, __csp
  MOVR R1, R6
  MOV R7, 4
  SUB R1, R7
  LOADR R2, R1
  MOVR R1, R6
  MOV R7, 8
  SUB R1, R7
  LOADR R3, R1
strcmp_loop:
  LB R4, R2
  LB R5, R3
  CMP R4, R5
  JNZ strcmp_diff
  MOV R7, 0
  CMP R4, R7
  JZ strcmp_eq
  INC R2
  INC R3
  JMP strcmp_loop
strcmp_diff:
  MOVR R0, R4
  SUB R0, R5
  JMP strcmp_done
strcmp_eq:
  MOV R0, 0
strcmp_done:
  STORE R6, __csp
  POP R6
  RET

.data
__csp:
  .word 0
environ:
  .word 0

.bss
__stack:
  .space ${stackSize}
`;
}

export type LinkFormat = 'guest' | 'raw';

export interface LinkOptions {
  entry?: string;
  textOrigin?: number;
  format?: LinkFormat;
  gcSections?: boolean;
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
    gcSections: options.gcSections ?? true,
  });
  if (format === 'raw') return encodeExecutable(linked.executable);
  if (options.magic === undefined) {
    throw new Error('linkExecutableImage: guest format requires a magic value');
  }
  return flattenGuestExecutable(linked, textOrigin, options.magic);
}
