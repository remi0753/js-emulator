# chibicc-derived custom32 C frontend

This directory holds the real C frontend the roadmap's Phase 31 introduces, kept
isolated from the rest of the toolchain so the imported frontend design and the
local custom32 backend stay clearly separated.

## What this is

A TypeScript port of the architecture of
[chibicc](https://github.com/rui314/chibicc) (Rui Ueyama, MIT-licensed),
restructured to this project's idioms. The whole codebase implements its CPU,
OS, and toolchain in TypeScript, so chibicc is ported rather than vendored as
buildable C: this repository has no host C compiler in its pipeline, and a C
program could not run as part of `node --test`. The port mirrors upstream's file
split and naming so the design is recognizable and Phase 32+ can broaden it
file by file:

| File | chibicc counterpart | Role |
|------|---------------------|------|
| `tokenize.ts` | `tokenize.c` | source text -> token stream |
| `preprocess.ts` | `preprocess.c` | object/function-like macros + conditional directives (Phase 32 slice) |
| `type.ts` | `type.c` | C types, sizes/alignment, `add_type` |
| `parse.ts` | `parse.c` | recursive-descent parser + semantics |
| `codegen.ts` | `codegen.c` | **custom32 backend (local, not imported)** |
| `index.ts` | `main.c` | driver wiring the pipeline together |

The frontend (`tokenize`/`preprocess`/`type`/`parse`) is target independent. The
only target-dependent pieces are the ABI type sizes (in `type.ts`, sourced from
`docs/custom32-c-abi.md`) and the whole of `codegen.ts`.

## Phase 31 slice

This first slice deliberately covers only what Phase 31 requires:

- integer expressions (arithmetic, bitwise, shift, comparison, logical, unary);
- `int`/`char`/`void` types (with `short`/`long`/`unsigned`/`signed` accepted),
  pointers, and arrays;
- local variables, parameters, and global variables (scalar constant and BSS);
- string and character literals;
- `if` / `while` / `for` / `break` / `continue` / `return` / blocks;
- function definitions, prototypes, and direct calls;
- the `__syscall` (and a few raw device/CPU) intrinsics for libc-free programs.

Not yet supported (Phase 32 and later): `float`/`double` soft-float arithmetic
and conversions. Later local slices added macro stringize/token-paste/includes,
`long long`, variadic functions, aggregate calls/returns, bit-fields, compound
literals, and VLAs.

## ABI

`codegen.ts` emits the same software-stack ABI as the bootstrap compiler
(`src/toolchain/c.ts`): a software stack pointer `__csp` holds C arguments and
locals, arguments are staged right-to-left, R6 is the frame base, and R0 is the
expression accumulator. This lets chibicc objects link against the existing,
tested `crt0Object()` startup/runtime and interoperate with bootstrap-compiled
libc. Migrating to the hardware-`SP` ABI frozen in `docs/custom32-c-abi.md` is
future work tracked in that document.
