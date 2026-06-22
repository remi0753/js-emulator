// Block disk device (v2). A sector-addressed disk on the port bus, backed by an
// in-memory byte array (which the kernel can load from / save to a host
// `disk.img` for persistence).
//
// PIO protocol, all through the port bus (so the mechanism is exercised end to
// end, exactly like the guest would drive it):
//
//   OUT DISK_POS,  sector   -> set the access position to sector*SECTOR_SIZE
//   OUT DISK_DATA, word     -> write a 32-bit word at the position; advance by 4
//   IN  DISK_DATA           -> read a 32-bit word at the position; advance by 4
//   IN  DISK_SECTORS        -> number of sectors on the disk
//
// A driver reads/writes a whole 512-byte sector as 128 little-endian words.

import type { PortDevice } from '../ports.ts';

export const SECTOR_SIZE = 512;

export class BlockDisk implements PortDevice {
  readonly data: Uint8Array;
  readonly sectors: number;
  private pos = 0; // current byte position for streaming

  // Optional deterministic trace hook (off by default; the Tracer wires it).
  // `seek` reports the target sector; `read`/`write` report the byte position.
  onIo: ((op: 'seek' | 'read' | 'write', at: number, value: number) => void) | null = null;

  // `backing` is the disk contents; its length must be a multiple of SECTOR_SIZE.
  constructor(backing: Uint8Array) {
    if (backing.length % SECTOR_SIZE !== 0) {
      throw new Error(`disk size must be a multiple of ${SECTOR_SIZE}`);
    }
    this.data = backing;
    this.sectors = backing.length / SECTOR_SIZE;
  }

  // Create a blank disk of `sectors` 512-byte sectors.
  static blank(sectors: number): BlockDisk {
    return new BlockDisk(new Uint8Array(sectors * SECTOR_SIZE));
  }

  read(port: number): number {
    if (port === PORT_DATA) {
      const v = this.read32(this.pos);
      this.onIo?.('read', this.pos, v);
      this.pos += 4;
      return v;
    }
    if (port === PORT_SECTORS) return this.sectors;
    throw new Error(`disk: bad read port 0x${port.toString(16)}`);
  }

  write(port: number, value: number): void {
    if (port === PORT_POS) {
      const sector = value >>> 0;
      this.pos = sector * SECTOR_SIZE;
      this.onIo?.('seek', this.pos, sector);
      return;
    }
    if (port === PORT_DATA) {
      this.write32(this.pos, value >>> 0);
      this.onIo?.('write', this.pos, value >>> 0);
      this.pos += 4;
      return;
    }
    throw new Error(`disk: bad write port 0x${port.toString(16)}`);
  }

  private read32(at: number): number {
    const b = this.data;
    return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
  }
  private write32(at: number, v: number): void {
    const b = this.data;
    b[at] = v & 0xff;
    b[at + 1] = (v >>> 8) & 0xff;
    b[at + 2] = (v >>> 16) & 0xff;
    b[at + 3] = (v >>> 24) & 0xff;
  }
}

// The disk's three port numbers (wired by the kernel; see abi.ts PORT).
// Re-exported there so all port assignments live in one table.
export const PORT_POS = 0x1f2;
export const PORT_DATA = 0x1f0;
export const PORT_SECTORS = 0x1f7;
