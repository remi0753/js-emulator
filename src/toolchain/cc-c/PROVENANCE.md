# cc-c — the C-source chibicc frontend, cross-compiled to run in the guest

This directory holds the **C-source** chibicc compiler that Phase 34 cross-compiles
into a guest executable, so a real C compiler can run *inside* the OS.

It is distinct from `src/toolchain/chibicc/`, which is the maintained **TypeScript
port** of chibicc that runs on the host. That TS port is the bootstrap
cross-compiler used to build the sources here. The two share an architecture but
not source language:

| | language | runs on | role |
|---|---|---|---|
| `src/toolchain/chibicc/` | TypeScript | host (`node`) | bootstrap cross-compiler |
| `src/toolchain/cc-c/` (this dir) | C | guest (custom32) | guest-native compiler |

## Layout

```
upstream/        vendored chibicc frontend C (MIT, Rui Ueyama), minimally patched
  chibicc.h tokenize.c preprocess.c parse.c type.c hashmap.c strings.c unicode.c
  LICENSE.chibicc
include/         freestanding compat headers so the frontend preprocesses under
                 the guest libc (stdbool, stdnoreturn, assert, glob, libgen,
                 strings, sys/*, time)
ccsupport.{h,c}  small libc gap-fillers the guest libc lacks (strndup, ispunct,
                 strcasecmp/strncasecmp, strerror, strtold, deterministic time)
codegen.c        custom32 backend — LOCAL, replaces upstream codegen.c (x86-64)
main.c           freestanding driver: read .c from FS, emit custom32 asm
probe.c          de-risking probe: tokenize an in-memory string with the real
                 chibicc tokenizer and report counts
```

`main.c` is a guest-native `cc -S` driver. It keeps upstream's process-spawning
driver out of the guest for now: it reads one C file from the guest filesystem,
runs tokenize/preprocess/parse/codegen in process, and writes custom32 assembly
back to the guest filesystem. Guest `as`/`ld` are still a separate Phase 34
slice before `cc` can produce and run executables entirely in the guest.

`codegen.c` is ported from the TS port's
`codegen.ts`, but walks upstream's Node/Obj/Type model and assigns local frame
offsets itself (as upstream's codegen.c does). It covers the integer / pointer /
struct / control-flow / 64-bit core the frontend itself uses; floating point,
VLAs/alloca, and atomics are the next backend slices and currently raise a
codegen error. `main.c`/glob/subprocess `as`/`ld` from upstream's driver are
replaced because the guest emits assembly directly rather than shelling out.

## Vendored revision

chibicc upstream `90d1f7f199cc55b13c7fdb5839d1409806633fdb`
(https://github.com/rui314/chibicc), MIT-licensed. See `upstream/LICENSE.chibicc`.

## Local patches to upstream/

Kept minimal and marked `[jscpu-os vendoring patch]`:

- `chibicc.h`: include `ccsupport.h` for the guest libc gap-fillers.

## Build

`src/v3/guest-chibicc.ts` cross-compiles these units with the TS chibicc port and
links them against the guest libc + crt0 + runtime helpers into a guest
executable. `buildChibiccProbe()` builds the tokenizer probe.
