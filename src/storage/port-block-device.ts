// Block-device adapter for a custom32 port bus. Reads and writes whole blocks by driving the disk
// device through the port bus — the same ports the guest would use.

import { PORT } from '../vm/custom32/platform.ts';
import type { PortBus } from '../vm/custom32/ports.ts';
import { BLOCK_SIZE, type BlockDevice } from './block.ts';

const WORDS_PER_BLOCK = BLOCK_SIZE / 4;

export class PortBlockDevice implements BlockDevice {
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
    const buf = new Uint8Array(BLOCK_SIZE);
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
    if (buf.length !== BLOCK_SIZE) throw new Error(`block write needs ${BLOCK_SIZE} bytes`);
    this.ports.out(PORT.DISK_POS, b);
    for (let i = 0; i < WORDS_PER_BLOCK; i++) {
      const at = i * 4;
      const w =
        (buf[at]! | (buf[at + 1]! << 8) | (buf[at + 2]! << 16) | (buf[at + 3]! << 24)) >>> 0;
      this.ports.out(PORT.DISK_DATA, w);
    }
  }
}
