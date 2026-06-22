// Block driver (v2). Reads and writes whole 512-byte blocks by driving the disk
// device through the port bus — the same ports the guest would use.

import { SECTOR_SIZE } from '../hw/devices/disk.ts';
import type { PortBus } from '../hw/ports.ts';
import { PORT } from './abi.ts';

export const BSIZE = SECTOR_SIZE; // filesystem block size == disk sector size
const WORDS_PER_BLOCK = BSIZE / 4;

export class BlockDriver {
  private ports: PortBus;

  constructor(ports: PortBus) {
    this.ports = ports;
  }

  get blocks(): number {
    return this.ports.in(PORT.DISK_SECTORS);
  }

  // Read block `b` into a fresh 512-byte buffer.
  read(b: number): Uint8Array {
    this.ports.out(PORT.DISK_POS, b);
    const buf = new Uint8Array(BSIZE);
    for (let i = 0; i < WORDS_PER_BLOCK; i++) {
      const w = this.ports.in(PORT.DISK_DATA);
      const at = i * 4;
      buf[at] = w & 0xff;
      buf[at + 1] = (w >>> 8) & 0xff;
      buf[at + 2] = (w >>> 16) & 0xff;
      buf[at + 3] = (w >>> 24) & 0xff;
    }
    return buf;
  }

  // Write a 512-byte buffer to block `b`.
  write(b: number, buf: Uint8Array): void {
    if (buf.length !== BSIZE) throw new Error(`block write needs ${BSIZE} bytes`);
    this.ports.out(PORT.DISK_POS, b);
    for (let i = 0; i < WORDS_PER_BLOCK; i++) {
      const at = i * 4;
      const w =
        (buf[at]! | (buf[at + 1]! << 8) | (buf[at + 2]! << 16) | (buf[at + 3]! << 24)) >>> 0;
      this.ports.out(PORT.DISK_DATA, w);
    }
  }
}
