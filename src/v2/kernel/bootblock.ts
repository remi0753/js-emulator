// Boot block / disk manifest (v2, Phase 9).
//
// The disk-image contract. Sector 0 (the "boot block", which the filesystem
// already reserves and never touches) carries a small manifest describing how to
// bring the system up. A boot ROM / boot command reads this sector first, then
// uses it to find the filesystem and the program to start.
//
// Stable on-disk layout of the whole image:
//
//   block 0: boot block (this manifest)   <- reserved by the FS, written here
//   block 1: filesystem superblock
//   block 2..: inodes, bitmap, data (the xv6-like FS: /bin/* userland + files)
//
// The manifest also reserves a contiguous raw kernel-image region (kernelStart /
// kernelBlocks). It is empty for now (model A: the kernel is TypeScript); when a
// guest kernel exists (model B, Phase 11) the boot ROM will load those blocks
// into physical memory and jump to the kernel's entry in KERNEL mode.

import { BSIZE } from './disk.ts';

export const BOOT_MAGIC = 0x544f4f42; // 'BOOT' little-endian
export const BOOT_VERSION = 1;
export const BOOT_SIGNATURE = 0xaa55; // last two bytes (0x55,0xAA), boot-sector style
const INITPATH_MAX = 64;

export interface BootBlock {
  magic: number;
  version: number;
  fsBlock: number; // block holding the filesystem superblock (1)
  kernelStart: number; // first block of the raw kernel image (0 = none yet)
  kernelBlocks: number; // length of the kernel image in blocks (0 = none yet)
  initPath: string; // path of the first user program the kernel should start
}

// Build a boot block with sensible defaults; only `initPath` is usually set.
export function makeBootBlock(initPath: string, extra: Partial<BootBlock> = {}): BootBlock {
  return {
    magic: BOOT_MAGIC,
    version: BOOT_VERSION,
    fsBlock: 1,
    kernelStart: 0,
    kernelBlocks: 0,
    initPath,
    ...extra,
  };
}

// Serialize a boot block into a full 512-byte sector.
export function encodeBootBlock(bb: BootBlock): Uint8Array {
  const path = bb.initPath;
  if (path.length > INITPATH_MAX) throw new Error(`boot: initPath too long: ${path}`);

  const buf = new Uint8Array(BSIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, bb.magic, true);
  dv.setUint32(4, bb.version, true);
  dv.setUint32(8, bb.fsBlock, true);
  dv.setUint32(12, bb.kernelStart, true);
  dv.setUint32(16, bb.kernelBlocks, true);
  dv.setUint32(20, path.length, true);
  for (let i = 0; i < path.length; i++) buf[24 + i] = path.charCodeAt(i) & 0xff;
  dv.setUint16(BSIZE - 2, BOOT_SIGNATURE, true);
  return buf;
}

// Parse a boot block from sector 0. Does not throw on a bad magic — the caller
// checks `magic` so it can give a clear "not a bootable disk" error.
export function decodeBootBlock(buf: Uint8Array): BootBlock {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = Math.min(dv.getUint32(20, true), INITPATH_MAX);
  let initPath = '';
  for (let i = 0; i < len; i++) initPath += String.fromCharCode(buf[24 + i]!);
  return {
    magic: dv.getUint32(0, true),
    version: dv.getUint32(4, true),
    fsBlock: dv.getUint32(8, true),
    kernelStart: dv.getUint32(12, true),
    kernelBlocks: dv.getUint32(16, true),
    initPath,
  };
}
