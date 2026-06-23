// A small Unix-like filesystem (v2), xv6-flavored, on the block device.
//
// On-disk layout (each block is BSIZE = 512 bytes):
//
//   [ boot | super | inode blocks ... | bitmap ... | data blocks ... ]
//      0      1      inodestart         bmapstart     (rest)
//
// - Superblock (block 1): magic + geometry.
// - Inodes: fixed 64-byte dinodes, IPB per block; inode 1 is the root dir.
// - Bitmap: one bit per block (1 = allocated).
// - Files/dirs: NDIRECT direct block pointers + 1 singly-indirect block.
// - Directories: arrays of fixed 16-byte entries { inum(u16), name[14] }.

import { type BlockDriver, BSIZE } from './disk.ts';

export const ROOTINO = 1; // root directory inode number
export const NDIRECT = 12;
export const NINDIRECT = BSIZE / 4; // 128
export const MAXFILE = NDIRECT + NINDIRECT;

const DINODE_SIZE = 64;
const IPB = BSIZE / DINODE_SIZE; // inodes per block (8)
const NADDR = NDIRECT + 1; // direct pointers + the indirect pointer
const BPB = BSIZE * 8; // bits (blocks) per bitmap block

export const DIRSIZ = 14;
const DIRENT_SIZE = 16; // u16 inum + 14-byte name

export const FSMAGIC = 0x10203040;

// Inode types.
export const T_DIR = 1;
export const T_FILE = 2;

export interface Superblock {
  magic: number;
  size: number; // total blocks
  ninodes: number;
  inodestart: number;
  bmapstart: number;
}

// In-memory form of an on-disk inode.
export interface Dinode {
  type: number; // 0 = free, T_DIR, T_FILE
  nlink: number;
  size: number; // bytes
  addrs: number[]; // length NADDR (12 direct + 1 indirect)
}

export class FsError extends Error {}

export class Fs {
  private disk: BlockDriver;
  sb!: Superblock;

  constructor(disk: BlockDriver) {
    this.disk = disk;
  }

  // --- mount / format ---

  // Read the superblock from disk (call after the disk holds a formatted image).
  mount(): void {
    this.sb = decodeSuperblock(this.disk.read(1));
    if (this.sb.magic !== FSMAGIC) throw new FsError('mount: bad filesystem magic');
  }

  // Format the whole disk: lay out metadata, mark it used, and create an empty
  // root directory (with "." and ".."). Leaves the FS mounted.
  mkfs(ninodes = 200): void {
    const size = this.disk.blocks;
    const ninodeblocks = Math.ceil(ninodes / IPB);
    const inodestart = 2;
    const bmapstart = inodestart + ninodeblocks;
    const nbitmap = Math.ceil(size / BPB);
    const datastart = bmapstart + nbitmap;

    // Zero every block.
    const zero = new Uint8Array(BSIZE);
    for (let b = 0; b < size; b++) this.disk.write(b, zero.slice());

    this.sb = { magic: FSMAGIC, size, ninodes, inodestart, bmapstart };
    this.disk.write(1, encodeSuperblock(this.sb));

    // Mark all metadata blocks (everything before the data region) as used.
    for (let b = 0; b < datastart; b++) this.setBit(b, true);

    // Create the root directory as inode ROOTINO.
    const root = this.ialloc(T_DIR);
    if (root !== ROOTINO) throw new FsError('mkfs: root inode is not ROOTINO');
    const din = this.readInode(root);
    din.nlink = 2; // "." and the parent link
    this.iupdate(root, din);
    this.dirLink(root, '.', root);
    this.dirLink(root, '..', root);
  }

  // --- inodes ---

  private inodeLoc(inum: number): { block: number; off: number } {
    if (inum <= 0 || inum >= this.sb.ninodes) throw new FsError(`bad inode ${inum}`);
    return { block: this.sb.inodestart + Math.floor(inum / IPB), off: (inum % IPB) * DINODE_SIZE };
  }

  readInode(inum: number): Dinode {
    const { block, off } = this.inodeLoc(inum);
    return decodeDinode(this.disk.read(block), off);
  }

  iupdate(inum: number, din: Dinode): void {
    const { block, off } = this.inodeLoc(inum);
    const buf = this.disk.read(block);
    encodeDinode(din, buf, off);
    this.disk.write(block, buf);
  }

  // Allocate a free inode of the given type.
  ialloc(type: number): number {
    for (let inum = 1; inum < this.sb.ninodes; inum++) {
      const { block, off } = this.inodeLoc(inum);
      const buf = this.disk.read(block);
      if (decodeDinode(buf, off).type === 0) {
        encodeDinode({ type, nlink: 0, size: 0, addrs: new Array(NADDR).fill(0) }, buf, off);
        this.disk.write(block, buf);
        return inum;
      }
    }
    throw new FsError('ialloc: out of inodes');
  }

  // Free an inode and all of its data blocks (truncate to nothing).
  ifree(inum: number, din: Dinode): void {
    this.itrunc(inum, din);
    din.type = 0;
    din.nlink = 0;
    this.iupdate(inum, din);
  }

  // --- block bitmap ---

  private bit(b: number): { block: number; byte: number; mask: number } {
    return {
      block: this.sb.bmapstart + Math.floor(b / BPB),
      byte: Math.floor((b % BPB) / 8),
      mask: 1 << (b % 8),
    };
  }

  private setBit(b: number, on: boolean): void {
    const { block, byte, mask } = this.bit(b);
    const buf = this.disk.read(block);
    if (on) buf[byte]! |= mask;
    else buf[byte]! &= ~mask;
    this.disk.write(block, buf);
  }

  private testBit(b: number): boolean {
    const { block, byte, mask } = this.bit(b);
    return (this.disk.read(block)[byte]! & mask) !== 0;
  }

  // Allocate a zeroed data block; returns its block number.
  balloc(): number {
    for (let b = 0; b < this.sb.size; b++) {
      if (!this.testBit(b)) {
        this.setBit(b, true);
        this.disk.write(b, new Uint8Array(BSIZE));
        return b;
      }
    }
    throw new FsError('balloc: out of disk blocks');
  }

  bfree(b: number): void {
    this.setBit(b, false);
  }

  // --- block mapping (file block index -> disk block) ---

  // Return the disk block backing file block `bn`, allocating it (and the
  // indirect block) if `alloc` is set. Mutates `din`/the indirect block.
  bmap(din: Dinode, bn: number, alloc: boolean): number {
    if (bn < NDIRECT) {
      let addr = din.addrs[bn]!;
      if (addr === 0 && alloc) {
        addr = this.balloc();
        din.addrs[bn] = addr;
      }
      return addr;
    }
    const idx = bn - NDIRECT;
    if (idx >= NINDIRECT) throw new FsError('bmap: file too large');

    let indirect = din.addrs[NDIRECT]!;
    if (indirect === 0) {
      if (!alloc) return 0;
      indirect = this.balloc();
      din.addrs[NDIRECT] = indirect;
    }
    const ib = this.disk.read(indirect);
    let addr = read32(ib, idx * 4);
    if (addr === 0 && alloc) {
      addr = this.balloc();
      write32(ib, idx * 4, addr);
      this.disk.write(indirect, ib);
    }
    return addr;
  }

  // Free every data block of an inode and reset its size.
  itrunc(inum: number, din: Dinode): void {
    for (let i = 0; i < NDIRECT; i++) {
      if (din.addrs[i]) {
        this.bfree(din.addrs[i]!);
        din.addrs[i] = 0;
      }
    }
    if (din.addrs[NDIRECT]) {
      const ib = this.disk.read(din.addrs[NDIRECT]!);
      for (let i = 0; i < NINDIRECT; i++) {
        const a = read32(ib, i * 4);
        if (a) this.bfree(a);
      }
      this.bfree(din.addrs[NDIRECT]!);
      din.addrs[NDIRECT] = 0;
    }
    din.size = 0;
    this.iupdate(inum, din);
  }

  // --- file read / write ---

  // Read up to `n` bytes from `din` starting at byte offset `off`. Returns the
  // bytes actually read (clamped to the file size).
  readi(din: Dinode, off: number, n: number): Uint8Array {
    if (off > din.size) return new Uint8Array(0);
    const end = Math.min(off + n, din.size);
    const out = new Uint8Array(end - off);
    let dst = 0;
    for (let pos = off; pos < end; ) {
      const block = this.bmap(din, Math.floor(pos / BSIZE), false);
      const within = pos % BSIZE;
      const take = Math.min(BSIZE - within, end - pos);
      if (block !== 0) {
        const buf = this.disk.read(block);
        out.set(buf.subarray(within, within + take), dst);
      } // a hole reads as zeros (out is already zero-filled)
      pos += take;
      dst += take;
    }
    return out;
  }

  // Write `data` into `din` at byte offset `off`, growing the file as needed.
  // Persists the inode. Returns the number of bytes written.
  writei(inum: number, din: Dinode, off: number, data: Uint8Array): number {
    if (off + data.length > MAXFILE * BSIZE) throw new FsError('writei: file too large');
    let src = 0;
    for (let pos = off; src < data.length; ) {
      const block = this.bmap(din, Math.floor(pos / BSIZE), true);
      const within = pos % BSIZE;
      const take = Math.min(BSIZE - within, data.length - src);
      const buf = this.disk.read(block);
      buf.set(data.subarray(src, src + take), within);
      this.disk.write(block, buf);
      pos += take;
      src += take;
    }
    if (off + data.length > din.size) din.size = off + data.length;
    this.iupdate(inum, din);
    return data.length;
  }

  // Read an entire file's contents.
  readFile(inum: number): Uint8Array {
    const din = this.readInode(inum);
    return this.readi(din, 0, din.size);
  }

  // --- directories ---

  // Look up `name` in directory `dirInum`; returns the child inum or 0.
  dirLookup(dirInum: number, name: string): number {
    const din = this.readInode(dirInum);
    if (din.type !== T_DIR) throw new FsError('dirLookup: not a directory');
    const data = this.readi(din, 0, din.size);
    for (let off = 0; off + DIRENT_SIZE <= data.length; off += DIRENT_SIZE) {
      const inum = data[off]! | (data[off + 1]! << 8);
      if (inum === 0) continue;
      if (decodeName(data, off + 2) === name) return inum;
    }
    return 0;
  }

  // Add an entry (name -> inum) to directory `dirInum`. Reuses a free slot if any.
  dirLink(dirInum: number, name: string, inum: number): void {
    if (name.length > DIRSIZ) throw new FsError(`dirLink: name too long: ${name}`);
    const din = this.readInode(dirInum);
    const data = this.readi(din, 0, din.size);

    let slot = data.length; // default: append
    for (let off = 0; off + DIRENT_SIZE <= data.length; off += DIRENT_SIZE) {
      if ((data[off]! | (data[off + 1]! << 8)) === 0) {
        slot = off;
        break;
      }
    }
    const ent = new Uint8Array(DIRENT_SIZE);
    ent[0] = inum & 0xff;
    ent[1] = (inum >>> 8) & 0xff;
    encodeName(name, ent, 2);
    this.writei(dirInum, din, slot, ent);
  }

  // List the entries of a directory as { name, inum } pairs (excludes free slots).
  readdir(dirInum: number): { name: string; inum: number }[] {
    const din = this.readInode(dirInum);
    if (din.type !== T_DIR) throw new FsError('readdir: not a directory');
    const data = this.readi(din, 0, din.size);
    const out: { name: string; inum: number }[] = [];
    for (let off = 0; off + DIRENT_SIZE <= data.length; off += DIRENT_SIZE) {
      const inum = data[off]! | (data[off + 1]! << 8);
      if (inum !== 0) out.push({ name: decodeName(data, off + 2), inum });
    }
    return out;
  }

  // --- path resolution ---

  private split(path: string): string[] {
    return path.split('/').filter((s) => s.length > 0);
  }

  // Resolve an absolute path to an inum, or 0 if any component is missing.
  namei(path: string): number {
    let inum = ROOTINO;
    for (const part of this.split(path)) {
      inum = this.dirLookup(inum, part);
      if (inum === 0) return 0;
    }
    return inum;
  }

  // Resolve the parent directory of an absolute path; returns { parent, name }.
  // `parent` is 0 if an intermediate directory is missing.
  nameiParent(path: string): { parent: number; name: string } {
    const parts = this.split(path);
    if (parts.length === 0) return { parent: 0, name: '' };
    const name = parts[parts.length - 1]!;
    let inum = ROOTINO;
    for (let i = 0; i < parts.length - 1; i++) {
      inum = this.dirLookup(inum, parts[i]!);
      if (inum === 0) return { parent: 0, name };
    }
    return { parent: inum, name };
  }

  // Create a file or directory at `path`. Returns its inum (existing file is
  // returned as-is for T_FILE; creating over an existing name fails otherwise).
  create(path: string, type: number): number {
    const { parent, name } = this.nameiParent(path);
    if (parent === 0) throw new FsError(`create: no such directory for ${path}`);

    const existing = this.dirLookup(parent, name);
    if (existing !== 0) {
      const din = this.readInode(existing);
      if (type === T_FILE && din.type === T_FILE) return existing;
      throw new FsError(`create: ${path} already exists`);
    }

    const inum = this.ialloc(type);
    const din = this.readInode(inum);
    din.nlink = 1;
    this.iupdate(inum, din);

    if (type === T_DIR) {
      this.dirLink(inum, '.', inum);
      this.dirLink(inum, '..', parent);
    }
    this.dirLink(parent, name, inum);
    return inum;
  }

  mkdir(path: string): number {
    return this.create(path, T_DIR);
  }

  // Create every missing directory along `path` (like `mkdir -p`).
  mkdirp(path: string): void {
    const parts = this.split(path);
    let cur = '';
    let inum = ROOTINO;
    for (const part of parts) {
      cur += `/${part}`;
      const child = this.dirLookup(inum, part);
      inum = child !== 0 ? child : this.mkdir(cur);
    }
  }

  // Convenience: write `data` to `path`, creating/truncating the file. Creates
  // any missing parent directories. Returns the file's inum.
  writeFile(path: string, data: Uint8Array): number {
    const slash = path.lastIndexOf('/');
    if (slash > 0) this.mkdirp(path.slice(0, slash));
    const inum = this.create(path, T_FILE);
    const din = this.readInode(inum);
    this.itrunc(inum, din);
    this.writei(inum, din, 0, data);
    return inum;
  }
}

// --- encode / decode helpers ---

function read32(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
}
function write32(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff;
  b[at + 3] = (v >>> 24) & 0xff;
}

function encodeSuperblock(sb: Superblock): Uint8Array {
  const buf = new Uint8Array(BSIZE);
  write32(buf, 0, sb.magic);
  write32(buf, 4, sb.size);
  write32(buf, 8, sb.ninodes);
  write32(buf, 12, sb.inodestart);
  write32(buf, 16, sb.bmapstart);
  return buf;
}
function decodeSuperblock(buf: Uint8Array): Superblock {
  return {
    magic: read32(buf, 0),
    size: read32(buf, 4),
    ninodes: read32(buf, 8),
    inodestart: read32(buf, 12),
    bmapstart: read32(buf, 16),
  };
}

function encodeDinode(din: Dinode, buf: Uint8Array, off: number): void {
  buf[off] = din.type & 0xff;
  buf[off + 1] = (din.type >>> 8) & 0xff;
  buf[off + 2] = din.nlink & 0xff;
  buf[off + 3] = (din.nlink >>> 8) & 0xff;
  write32(buf, off + 4, din.size);
  for (let i = 0; i < NADDR; i++) write32(buf, off + 8 + i * 4, din.addrs[i] ?? 0);
}
function decodeDinode(buf: Uint8Array, off: number): Dinode {
  const addrs: number[] = [];
  for (let i = 0; i < NADDR; i++) addrs.push(read32(buf, off + 8 + i * 4));
  return {
    type: buf[off]! | (buf[off + 1]! << 8),
    nlink: buf[off + 2]! | (buf[off + 3]! << 8),
    size: read32(buf, off + 4),
    addrs,
  };
}

function encodeName(name: string, buf: Uint8Array, off: number): void {
  for (let i = 0; i < DIRSIZ; i++) buf[off + i] = i < name.length ? name.charCodeAt(i) & 0xff : 0;
}
function decodeName(buf: Uint8Array, off: number): string {
  let s = '';
  for (let i = 0; i < DIRSIZ; i++) {
    const c = buf[off + i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
