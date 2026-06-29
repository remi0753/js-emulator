# Vendored zlib (test fixture)

Real, unmodified [zlib](https://github.com/madler/zlib) **v1.3.1** source,
fetched verbatim from `github.com/madler/zlib` at tag `v1.3.1`. Used by
`test/guest-zlib.test.ts` to prove the guest-native C toolchain can compile and
run a real third-party C library entirely inside the emulated OS.

Only the subset needed for the `compress()`/`uncompress()` round trip is
vendored (no gzip file I/O, no `infback`):

- C: adler32.c, crc32.c, deflate.c, inffast.c, inflate.c, inftrees.c, trees.c,
  zutil.c, compress.c, uncompr.c
- headers: zlib.h, zconf.h, zutil.h, deflate.h, trees.h, inftrees.h, inflate.h,
  inffast.h, inffixed.h, crc32.h, gzguts.h

The files are byte-for-byte upstream. The test does NOT edit them on disk; the
only build-time adjustment is prepending `#define DYNAMIC_CRC_TABLE` to crc32.c
when staging it into the guest, so the CRC tables are computed at runtime instead
of pulling in the ~9400-line static `crc32.h` (keeps the guest compile small).

zlib is licensed under the zlib License (permissive); see the copyright notice in
`zlib.h`.
