// Disk-image builder and boot path (v2, Phase 9).
//
// `buildDiskImage()` is a first-class image builder: it formats a fresh disk,
// installs the userland onto the filesystem, seeds a few files, and writes the
// boot block (manifest) into sector 0. The result is a self-describing `disk.img`.
//
// `bootImage()` is the counterpart: given image bytes, it mounts the filesystem
// and boots through the manifest in sector 0 — without installing userland or
// hard-coding which program is init. The userland already lives on the disk, and
// the manifest says what to run. (See tools/mkimg.ts and tools/boot.ts.)

import { encodeBootBlock, makeBootBlock } from '../formats/bootblock.ts';
import { Kernel, type KernelOptions } from './kernel/kernel.ts';
import { installUserland } from './userland/programs.ts';

// Files seeded into a freshly built image (so `cat`/`ls` have something to show).
export const DEFAULT_SEED: Record<string, string> = {
  '/etc/motd': 'jscpu-os v2 — booted from a disk image!\n',
  '/README': 'hello from the on-disk filesystem\n',
};

export interface BuildOptions {
  diskBlocks?: number; // disk size in 512-byte blocks (default: kernel/machine default)
  initPath?: string; // program the boot block points at (default /bin/init)
  seed?: Record<string, string>; // extra/replacement seed files
}

// Build a complete, bootable disk image and return its raw bytes. This is the
// "build" half of the Phase 9 contract: one call produces a disk.img.
export function buildDiskImage(opts: BuildOptions = {}): Uint8Array {
  const initPath = opts.initPath ?? '/bin/init';

  // A fresh disk (no diskImage) makes the kernel format the filesystem.
  const kernel = new Kernel({ diskBlocks: opts.diskBlocks, log: () => {} });
  installUserland(kernel);

  const seed = { ...DEFAULT_SEED, ...(opts.seed ?? {}) };
  for (const [path, content] of Object.entries(seed)) kernel.fs.writeFile(path, text(content));

  // Write the boot block last; the FS reserves sector 0 and never touches it.
  kernel.bio.write(0, encodeBootBlock(makeBootBlock(initPath)));
  return kernel.disk.data;
}

// Boot a disk image: mount it and start init through the boot block. This is the
// "boot" half of the contract — note it never calls installUserland() or
// spawnFromFile(). Returns a kernel with init spawned; call kernel.run() next.
export function bootImage(
  diskBytes: Uint8Array,
  opts: Omit<KernelOptions, 'diskImage' | 'machine'> = {},
): Kernel {
  const kernel = new Kernel({ ...opts, diskImage: diskBytes });
  kernel.boot();
  return kernel;
}

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
