# custom32-cc host C driver and ABI smoke suite (Phase 30)

This document specifies the `custom32-cc` host driver — a `cc`-style front end
that compiles C with the chibicc-derived frontend and ties the existing
assembler, object linker, archive search, and disk install stages together.

```text
custom32-cc  .c        -> .o    (compile one translation unit, with -c)
custom32-cc  .c/.s/.o/.a -> exe (compile, assemble, link, optionally install)
```

The driver reuses the Phase 29 object pipeline: a C translation unit is compiled
to a relocatable [`.o`](custom32-objfmt.md), then linked with objects, static
archives, and a startup object exactly like hand-written assembly. The legacy
TypeScript C-like compiler (`src/toolchain/c.ts`) remains for historical tests;
maintained guest builds use [`src/toolchain/chibicc/`](../src/toolchain/chibicc/).

## Pipeline

```text
compileObject(.c)  ->  .o   (compile + lower + assemble, no startup/runtime)
crt0Object()       ->  .o   (shared _start + software stack + runtime helpers)
linkObjects(...)   ->  exe  (resolve symbols, pull archive members, relocate)
flattenGuestExecutable / encodeExecutable -> guest header / JEX container
installExecutable  ->  disk.img  (write into the guest filesystem, mode 0755)
```

Source:

- [`src/toolchain/cc.ts`](../src/toolchain/cc.ts) — OS-generation-independent
  core: `compileObject`, `crt0Object`, and a generic `linkExecutableImage`.
- [`src/v3/guest-cc.ts`](../src/v3/guest-cc.ts) — guest specifics: the guest
  load base / executable magic (`linkGuestExecutable`) and disk-image install
  (`installExecutable`).
- [`tools/custom32-cc.ts`](../tools/custom32-cc.ts) — the command-line driver.

### Translation units carry no startup or runtime

If every C object embedded its own `_start`, software stack (`__csp`/`__stack`),
`environ`, and `memcpy`/`memset`/`strlen`/`strcmp`, linking two of them would
fail on duplicate global symbols. Instead:

- `compileObject` compiles each unit with chibicc and emits **no startup and no
  runtime**. The unit references `__csp` and the runtime helpers as
  **undefined** symbols and omits the shared
  `__csp`/`__stack`/`environ` definitions entirely.
- `crt0Object()` is the single object that **defines** `_start`, `__csp`,
  `__stack`, `environ`, and the runtime helpers. `_start` (the `user` startup)
  reads `argc`/`argv`/`envp` from the exec ABI, publishes `environ`, calls
  `main`, and exits with its return value.

`custom32-cc` links `crt0Object()` first unless `-nostartfiles` is given. Defined
C functions and non-`extern` globals are exported as global symbols; string
literals and the shared stack symbols are not.

### Compiling a unit to an object

The chibicc frontend preprocesses, parses, type-checks, and emits custom32
assembly; [`as.ts`](../src/toolchain/as.ts) then assembles that text into an
object file. Because the assembler turns every bare-identifier operand into an
`abs32` relocation, cross-object references (calls, globals, pointer
initializers) resolve at link time with no special cases.

## CLI

```text
custom32-cc [options] inputs...
```

Inputs by extension: `.c` compiled, `.s`/`.asm` assembled, `.o` objects, `.a`
archives (members pulled on demand).

| Option | Meaning |
| --- | --- |
| `-o out` | output path (executable, or the single `-c` object) |
| `-c` | compile/assemble only; emit one `.o` per input, do not link |
| `-e`, `--entry NAME` | entry symbol (default `_start`) |
| `--format guest\|raw` | guest loader header (default) or generic JEX container |
| `--text-origin N` | override the text load address |
| `-L dir` / `-l name` | archive search path / link `libNAME.a` |
| `-nostartfiles` | do not link the built-in `crt0` startup/runtime object |
| `--frontend chibicc` | accepted for compatibility; chibicc is the only maintained frontend |
| `--install IMG` | install the linked executable into disk image `IMG` |
| `--install-as PATH` | guest path for `--install` (default `/bin/<output name>`) |

Example: build a multi-file program against a static archive and install it.

```sh
custom32-cc -c -o libc.o libc.c
custom32-ar rc libabi.a libc.o
custom32-cc -o prog main.c helpers.c -L. -labi \
            --install disk.img --install-as /bin/prog
```

## ABI smoke suite

`test/cc-abi-phase30.test.ts` is the suite that locks the ABI before the
frontend changes. It compiles and runs tiny programs covering:

- function **calls**, **globals**, **pointers**, **structs** (a struct-pointer
  argument), and **arrays**;
- **libc calls** through an archived mini-libc (`write`/`fork`/`exec`/`wait`/
  `exit`/`puts`/`putnum` over `INT 0x80`);
- **multiple translation units** and **archive** member-on-demand search;
- **startup code**, **argv/envp** delivery, and **exit status** reporting.

The end-to-end test links `crt0` + `abimain.o` + `helpers.o` against `libabi.a`
into `/bin/abimain` and `crt0` + `abichild.o` into `/bin/abichild`, installs both
into a disk image, boots the guest, runs `abimain` from the shell, and asserts
the console output (`compute=117`, the child's echoed `argv[0]`/`environ[0]`, and
`child exited 7`). The same flow is exercised through the `custom32-cc` CLI,
which also asserts the CLI-built executable matches the in-process pipeline byte
for byte.

## C frontend

The chibicc frontend is a TypeScript port of
[chibicc](https://github.com/rui314/chibicc)'s architecture, kept isolated so the
imported frontend (`tokenize.ts`/`preprocess.ts`/`type.ts`/`parse.ts`) stays
separate from the custom32 backend (`codegen.ts`); see
[`PROVENANCE.md`](../src/toolchain/chibicc/PROVENANCE.md). Its Phase 31 slice
emitted the same software-stack ABI as the bootstrap compiler; the maintained
driver now uses chibicc directly for kernel, userland, and CLI builds. The
end-to-end coverage is `test/chibicc-phase31.test.ts`, which builds
`int main(void) { return 42; }` through this driver, boots the guest, and
observes exit status 42.

## npm scripts

`npm run cc` invokes the driver; it is also exposed as the `bin` entry
`custom32-cc`.
