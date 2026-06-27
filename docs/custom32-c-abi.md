# custom32 C ABI

This document freezes the ILP32 C ABI that future custom32 C compilers,
assemblers, linkers, the guest kernel, libc, and debugging tools must share.
The existing TypeScript C-like compiler is a bootstrap compiler; its migration
notes are at the end of this document.

## Data Model

custom32 uses little-endian ILP32.

| C type | Size | Alignment | Notes |
|--------|------|-----------|-------|
| `char` | 1 | 1 | Plain `char` is signed. `_Bool` uses 1 byte when added. |
| `short` | 2 | 2 | Two's-complement signed integer. |
| `int` | 4 | 4 | Two's-complement signed integer. |
| `long` | 4 | 4 | Same representation as `int`. |
| `long long` | 8 | 4 | Passed and returned as two 32-bit words. |
| pointer | 4 | 4 | Flat 32-bit virtual address. |
| `float` | 4 | 4 | IEEE-754 binary32, implemented by soft-float helpers. |
| `double` | 8 | 4 | IEEE-754 binary64, implemented by soft-float helpers. |

Integer overflow follows the C language rules. The ISA provides signed
overflow-aware `CMP` flags, signed `IDIV`/`IMOD`, unsigned `DIV`/`MOD`,
logical `SHR`, arithmetic `SAR`, and sign-extending `LBS`/`LHS` for code
generation.

## Registers

`R0`-`R7` are general-purpose 32-bit registers. `SP` is the single C stack
pointer and grows downward. The ABI does not use the bootstrap compiler's
software `__csp` as a second stack.

| Register | ABI role |
|----------|----------|
| `R0` | return value low word, scratch |
| `R1` | return value high word or hidden aggregate-return pointer, scratch |
| `R2`-`R5` | scratch / caller-saved |
| `R6` | callee-saved frame pointer when a frame pointer is emitted |
| `R7` | callee-saved general register |

Callers must assume `R0`-`R5` and flags are clobbered by a call. Callees must
restore `R6`, `R7`, and `SP` before returning.

## Stack and Calls

The stack is 8-byte aligned at every public function entry. A call pushes a
4-byte return address. The caller then owns argument cleanup.

Arguments are pushed right-to-left before `CALL`/`CALLR`. At callee entry,
`SP` points at the return address, the first source-level argument is at
`SP + 4`, the second at `SP + 8`, and so on. Each argument occupies at least
one 4-byte slot. `char` and `short` arguments are extended by the caller to
`int`; unsigned types are zero-extended and signed types are sign-extended.
`long long` and `double` occupy two consecutive slots, low word first.

Functions return with `RET`. Function pointers are ordinary code addresses and
are called with `CALLR`.

## Return Values

Scalar 32-bit and smaller values return in `R0`; narrow integer returns are
extended to `int`. `long long` and `double` return low word in `R0` and high
word in `R1`. `float` returns its binary32 bits in `R0`.

Structs/unions of 4 bytes or less may return in `R0`. Structs/unions of 8 bytes
or less may return in `R0:R1`. Larger aggregate returns use a hidden pointer:
the caller allocates the result object, passes its address as an implicit first
argument, and the callee returns that same address in `R0`.

## Aggregate Layout

Struct fields are laid out in declaration order. Each field starts at the next
offset aligned to that field's alignment, capped at 4. The struct size is
rounded up to the maximum field alignment, also capped at 4. Unions have the
size and alignment of their largest member, with alignment capped at 4.

Enums have the size and alignment of `int`. Bit-fields use `int` allocation
units, allocate from least significant bit to most significant bit within each
unit, and do not cross a 32-bit unit. A zero-width bit-field forces the next
field to a new 32-bit unit.

## Variadic Functions

Variadic arguments live in the same stack argument area as fixed arguments.
`va_list` is a pointer to the next 4-byte argument slot. `va_arg` advances by
the rounded slot size of the requested type. Because all narrow integer and
floating arguments are promoted by C before a variadic call, `char`/`short`
are read as `int`, and `float` is read as `double`.

## Runtime Helper Conventions

Helpers for operations not directly provided by the ISA follow the normal call
ABI. Names are reserved as compiler/runtime symbols:

| Helper family | Purpose |
|---------------|---------|
| `__i64_*`, `__u64_*` | 64-bit add/sub/mul/div/mod, shifts, comparisons, casts |
| `__fix*`, `__float*` | integer/float conversion helpers |
| `__addsf3`, `__subsf3`, `__mulsf3`, `__divsf3` | binary32 arithmetic |
| `__adddf3`, `__subdf3`, `__muldf3`, `__divdf3` | binary64 arithmetic |
| `__cmpsf2`, `__cmpdf2` | soft-float comparisons |

64-bit integer arguments and results use low word first. Soft-float helpers
receive and return raw IEEE bit patterns in normal integer registers/slots.

## Symbols, Relocations, and Executables

External C symbols use their source spelling without a leading underscore.
Public function and object symbols have default visibility unless marked
`static`, in which case they are object-local. The ABI assumes static linking,
absolute code/data addresses, no PIC, no dynamic loader, and no TLS for the
current self-hosting path.

Required relocation classes for the first real toolchain are:

| Relocation | Width | Meaning |
|------------|-------|---------|
| `R_CUSTOM32_ABS32` | 32 | Absolute address of a symbol plus addend. |
| `R_CUSTOM32_PC32` | 32 | Signed PC-relative displacement, for future compact branches/calls. |
| `R_CUSTOM32_SECTION32` | 32 | Section base plus addend, used by object dump/debug metadata. |

Executable files contain separate RX text, RW data, and zero-filled BSS
segments. The loader maps text non-writable, maps data/BSS writable, creates an
8-byte aligned user stack, and enters `_start` with process startup arguments
defined by the guest OS libc contract.

## Syscall Boundary

Userland enters the guest kernel with `INT 0x80`. Syscall number and arguments
are passed in registers as documented in `docs/syscalls.md`; raw kernel returns
are 32-bit signed values in `R0`. Negative values in the stable errno range are
errors. libc translates those to `-1` and sets positive `errno`.

Syscalls are not C calls: they clobber `R0`-`R5` and flags, preserve the user
stack according to trap-frame restore semantics, and preserve only registers the
kernel explicitly restores as part of the syscall ABI.

## Bootstrap Compiler Migration

The maintained TypeScript C-like compiler currently uses a software stack
symbol, `__csp`, for C locals and arguments while the hardware `SP` only carries
return addresses and trap frames. That convention remains valid only for the
bootstrap kernel/userland compiler.

The migration path is:

1. Keep the current compiler building the guest OS while phase 29-30 host tools
   and ABI smoke tests land.
2. Add a hardware-`SP` backend mode that uses the argument layout in this
   document and preserves `R6`/`R7`.
3. Move libc startup, syscall stubs, and kernel entry shims to the hardware
   stack ABI.
4. Retire `__csp` from newly compiled code once the chibicc custom32 backend can
   build the maintained userland.

Current compatibility status: the bootstrap compiler now emits signed
`IDIV`/`IMOD`, arithmetic `SAR` for signed `int >>`, and benefits from
overflow-aware signed branches. It does not yet implement `short`, `long`,
`long long`, unsigned integer types, floats, doubles, variadics, bit-fields, or
the hardware-`SP` function ABI.
