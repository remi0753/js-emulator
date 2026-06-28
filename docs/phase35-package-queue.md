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
   - Fails because guest `cc` still has no `-c` relocatable object output, no
     multi-input link, and no standalone guest `as`/`ld`/`ar`.
   - Next slice: teach the guest assembler/linker path to emit and consume the
     project object/archive format instead of only flat executables.

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
