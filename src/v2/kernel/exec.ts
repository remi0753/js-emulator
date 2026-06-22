// Minimal ELF-like executable format for v2.
//
// A program is a header plus one or more segments. Each segment is a chunk of
// the address space to populate: `fileSize` bytes are copied from the file and
// the remaining `memSize - fileSize` bytes are zero-filled (BSS). The loader
// (see kernel.ts) maps each segment into a fresh address space and starts the
// process at `entry` in USER mode.
//
// On-disk layout (little-endian):
//
//   header (12 bytes):  magic(u32) entry(u32) segCount(u32)
//   segCount x segment header (20 bytes each):
//                       vaddr(u32) fileOffset(u32) fileSize(u32) memSize(u32) flags(u32)
//   segment data blobs, each at its `fileOffset`
//
// This is deliberately tiny but real: it serializes to bytes and parses back, so
// in Phase 4 an executable is simply a file read off the disk.

import { LAYOUT } from './abi.ts';

export const EXE_MAGIC = 0x3158454a; // "JEX1" (little-endian)

// Segment permission flags.
export const SEG = { R: 1, W: 2, X: 4 } as const;

export interface Segment {
  vaddr: number; // virtual address the segment is mapped at (page-aligned)
  data: Uint8Array; // file bytes copied in (length = fileSize)
  memSize: number; // total size in memory; bytes past data.length are zeroed (BSS)
  flags: number; // SEG.R | SEG.W | SEG.X
}

export interface Executable {
  entry: number; // virtual entry point (where execution starts)
  segments: Segment[];
}

const HEADER_SIZE = 12;
const SEG_HDR_SIZE = 20;

// Serialize an executable to its on-disk byte form.
export function encodeExecutable(exe: Executable): Uint8Array {
  const n = exe.segments.length;
  let dataSize = 0;
  for (const s of exe.segments) dataSize += s.data.length;

  const total = HEADER_SIZE + n * SEG_HDR_SIZE + dataSize;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  dv.setUint32(0, EXE_MAGIC, true);
  dv.setUint32(4, exe.entry, true);
  dv.setUint32(8, n, true);

  let hdr = HEADER_SIZE;
  let fileOffset = HEADER_SIZE + n * SEG_HDR_SIZE;
  for (const s of exe.segments) {
    dv.setUint32(hdr, s.vaddr, true);
    dv.setUint32(hdr + 4, fileOffset, true);
    dv.setUint32(hdr + 8, s.data.length, true);
    dv.setUint32(hdr + 12, Math.max(s.memSize, s.data.length), true);
    dv.setUint32(hdr + 16, s.flags, true);
    buf.set(s.data, fileOffset);
    hdr += SEG_HDR_SIZE;
    fileOffset += s.data.length;
  }
  return buf;
}

// Parse an executable from its on-disk byte form.
export function parseExecutable(bytes: Uint8Array): Executable {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_SIZE || dv.getUint32(0, true) !== EXE_MAGIC) {
    throw new Error('bad executable: magic mismatch');
  }
  const entry = dv.getUint32(4, true);
  const n = dv.getUint32(8, true);

  const segments: Segment[] = [];
  for (let i = 0; i < n; i++) {
    const hdr = HEADER_SIZE + i * SEG_HDR_SIZE;
    const vaddr = dv.getUint32(hdr, true);
    const fileOffset = dv.getUint32(hdr + 4, true);
    const fileSize = dv.getUint32(hdr + 8, true);
    const memSize = dv.getUint32(hdr + 12, true);
    const flags = dv.getUint32(hdr + 16, true);
    if (fileOffset + fileSize > bytes.length)
      throw new Error('bad executable: segment out of range');
    segments.push({
      vaddr,
      data: bytes.subarray(fileOffset, fileOffset + fileSize),
      memSize,
      flags,
    });
  }
  return { entry, segments };
}

// Wrap a flat assembled image (text + data combined) as a single RWX segment
// loaded at the standard user text address. This is the bridge from the simple
// `assemble()` output to the executable format used by the loader.
export function flatExecutable(image: Uint8Array, vaddr = LAYOUT.USER_TEXT): Executable {
  return {
    entry: vaddr,
    segments: [{ vaddr, data: image, memSize: image.length, flags: SEG.R | SEG.W | SEG.X }],
  };
}
