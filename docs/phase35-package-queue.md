# Phase 35 Package Failure Queue

Phase 35 starts with a deterministic guest-side compiler rebuild loop before
trying larger third-party packages. The current maintained bootstrap installs
the exact guest compiler source bundle under `/usr/src/cc`, then runs `/bin/cc`
inside the guest to compile a small selfhost probe from that tree and compare
repeated stage outputs.

## Current Stage

- Stage 0: the host TypeScript chibicc port cross-builds `/bin/cc`.
- Stage 1 replay: guest `/bin/cc` compiles `/usr/src/cc/selfhost.c` into an
  assembly output on the persistent root filesystem.
- Stage 2 replay: the same guest compilation is repeated from the same source
  tree and the outputs are compared byte-for-byte by the deterministic test
  harness.

This proves that the guest compiler can rebuild meaningful pieces of itself
from guest filesystem sources and that the run is replayable. A complete
`/bin/cc` self-link is still blocked by missing guest object and archive
tooling.

## Failure Queue

1. **Full compiler relink**
   - Guest `cc` now has `-c` relocatable `.o` output, multi-input linking of
     `.o`/`.s` inputs, and standalone `/bin/as` and `/bin/ld` (see
     `test/guest-toolchain.test.ts`). The `.o` format is a flat serialization of
     one assembled image — text/data bytes, defined symbols, and relocations —
     private to `cc`/`as`/`ld` (`OBJ_MAGIC` in `cc-c/guestlink.c`). When no input
     supplies `_start`, the linker auto-injects the built-in crt, so a `-c`-then-
     link round-trip matches the single-source `cc -o` runtime.
   - Remaining gap: no archive (`ar`) tool yet, so a relink still lists every
     object explicitly rather than pulling members on demand from a `.a`.
   - Next slice: a guest `ar` plus on-demand archive member selection in the
     linker, then rewire the self-rebuild to compile each unit with `-c` and
     link the resulting `.o` set.

   - Compiler feature coverage landed since: the guest backend now does
     floating point via a soft-float runtime (linked from `/lib` on demand) and
     supports variadic functions through the macro-based `<stdarg.h>` and the
     right-to-left arg ABI (see `test/guest-cc-float.test.ts`). Fixed a latent
     `__divdf3` off-by-one in the shared soft-float runtime while wiring it up.

2. **zlib**
   - Expected blockers: multi-translation-unit builds, archive creation,
     Makefile-like build steps, and broader libc file APIs.
   - Start with a tiny fixed-command build script after guest `-c` and archive
     support exist.

3. **libpng**
   - Depends on zlib first.
   - Expected blockers: configure-time probes, larger headers, and wider
     integer/stdio coverage.

4. **SQLite**
   - Expected blockers: compiler feature coverage, larger translation-unit
     memory pressure, temp-file behavior, and long-running deterministic build
     budgets.
   - Try the amalgamation only after zlib/libpng expose and shrink the earlier
     toolchain/libc gaps.
