# custom32 object format, archives, and host toolchain (Phase 29)

This document specifies the relocatable object format, the static archive
format, and the host command-line tools that assemble, archive, link, and
inspect them. These tools take **hand-written assembly** (and, later, compiler
output) through an explicit object pipeline that is independent of the
source-level linker in `src/toolchain/linker.ts`.

```text
custom32-as   .s  -> .o    (assemble one translation unit)
custom32-ar   .o  -> .a    (collect objects into a static archive)
custom32-ld   .o/.a -> exe (resolve symbols, relocate, emit an executable)
custom32-objdump .o/.a -> text (inspect sections, symbols, relocations)
```

## Object format (`.o`)

Source: [`src/formats/object.ts`](../src/formats/object.ts). Magic `OBJ1`,
version 1, little-endian throughout.

An object has three sections and two tables:

- **text** — assembled instruction bytes (read/execute).
- **data** — initialized data bytes (read/write).
- **bss** — a size only; zero-filled at load time.
- **symbol table** — each symbol has a name, a section
  (`text`/`data`/`bss`/`undef`/`abs`), a binding (`local`/`global`), and a
  value (the offset within its section, or a literal value for `abs`).
  `undef` symbols are referenced here but defined elsewhere.
- **relocation table** — each relocation names a section (`text` or `data`), a
  byte offset, a target symbol index, a type, and an addend. The only type is
  `abs32`: the linker writes `symbolAddress + addend` as a little-endian 32-bit
  word into the field. This matches the ISA, whose jump/load/store operands and
  `.word` data are all absolute 32-bit values.

On-disk layout (deterministic order): a 36-byte header, then the text bytes,
the data bytes, the symbol table (12 bytes/entry), the relocation table
(16 bytes/entry), and a NUL-separated string table.

## Archive format (`.a`)

Source: [`src/formats/archive.ts`](../src/formats/archive.ts). Magic `AJR1`.

An archive is an ordered list of named members; each member is the raw bytes of
an object file. The linker pulls a member only if it provides a symbol that is
still undefined, so an archive behaves like a Unix `ar` library. Member order
is preserved exactly, and name offsets are absolute, so encoding is
deterministic.

## Assembler (`custom32-as`)

Source: [`src/toolchain/as.ts`](../src/toolchain/as.ts). Compared with the
absolute `src/assembler.ts`, the relocatable assembler resolves nothing to a
final address: every identifier operand becomes an `abs32` relocation against a
symbol, and every label becomes a symbol.

Directives:

- `.text` / `.data` / `.bss` — select the current section (default `.text`).
- `.global name` / `.globl name` — export a symbol (default binding is local).
- `.word v[,v...]` — 32-bit words; a value may be a symbol (relocated) with an
  optional `+N`/`-N` addend.
- `.byte v[,v...]` — 8-bit constants.
- `.string "..."` — NUL-terminated bytes.
- `.space N` / `.zero N` — reserve N zero bytes (grows `.bss` size).

Operands: registers `R0`–`R7`, decimal/`0x` hex/`'c'` char constants, or a
symbol reference (`name` or `name+N`).

## Linker (`custom32-ld`)

Source: [`src/toolchain/object-linker.ts`](../src/toolchain/object-linker.ts).

1. Load every explicit object, recording the global symbols it provides and the
   undefined symbols it requires. Duplicate global definitions are an error.
2. Pull archive members to a fixed point: any member providing a still-undefined
   symbol is admitted (which may introduce new undefined symbols). A remaining
   undefined symbol is an error.
3. Lay out sections at concrete addresses: all `text` first (at `--text-origin`,
   default the guest user load base), then `data` at the next page boundary,
   then `bss`. Each object's same-kind sections are concatenated in input/pull
   order and 4-byte aligned, while the emitted executable segments are
   page-aligned for the generic JEX loader.
4. Resolve every symbol address and apply relocations.
5. Emit the executable. `--format guest` (default) writes the 12-byte loadable
   header (magic, entry, memSize) the guest exec path consumes; `--format raw`
   writes the generic JEX container.

Options: `-o out`, `-e entry` (default `_start`), `--format guest|raw`,
`--text-origin N`, `-L dir`, `-l name` (searches for `lib<name>.a`).

## Dumper (`custom32-objdump`)

Source: [`src/toolchain/dump.ts`](../src/toolchain/dump.ts). Detects an object
or archive by magic and prints its sections, symbol table, and relocations (for
objects) or members and the symbols each provides (for archives), so a failing
link can be inspected without decoding binary blobs.

## Worked example

`test/object-toolchain-phase29.test.ts` assembles three hand-written units —
`puts` and `putdigit` (archived into `libio.a`) and the `/bin/child` and
`/bin/hello` programs — links each program against the archive (pulling only the
members it needs), installs the resulting guest executables into a disk image,
boots the guest, and verifies that `hello` forks/execs `child` and prints the
child's decoded exit status (`child exited 7`). The same flow is exercised
through the `custom32-as`/`custom32-ar`/`custom32-ld`/`custom32-objdump` CLIs.

## npm scripts

`npm run as`, `npm run ld`, `npm run ar`, and `npm run objdump` invoke the
corresponding tool; the tools are also exposed as the `bin` entries
`custom32-as`, `custom32-ld`, `custom32-ar`, and `custom32-objdump`.
