// Host-side block-device adapter backed directly by an in-memory byte array.
//
// Unlike PortBlockDevice, this does not drive the port bus word-by-word (128
// IN/OUT per 512-byte block); it copies whole blocks straight to/from the
// backing array. Use it for host-side staging (building disk images, installing
// toolchains) where the port-I/O mechanism does not need to be exercised — it is
// an order of magnitude faster. PortBlockDevice remains for code that must go
// through the bus exactly as the guest would.

import { BLOCK_SIZE, type BlockDevice } from './block.ts';

export class DirectBlockDevice implements BlockDevice {
  readonly data: Uint8Array;

  // `backing` is the disk contents; its length must be a multiple of BLOCK_SIZE.
  constructor(backing: Uint8Array) {
    if (backing.length % BLOCK_SIZE !== 0) {
      throw new Error(`disk size must be a multiple of ${BLOCK_SIZE}`);
    }
    this.data = backing;
  }

  get blocks(): number {
    return this.data.length / BLOCK_SIZE;
  }

  // Read block `b` into a fresh buffer (a copy, so callers can retain it safely).
  read(b: number): Uint8Array {
    const at = b * BLOCK_SIZE;
    if (at < 0 || at + BLOCK_SIZE > this.data.length) {
      throw new RangeError(`block read out of range: ${b}`);
    }
    return this.data.slice(at, at + BLOCK_SIZE);
  }

  // Write a whole block to the backing array.
  write(b: number, buf: Uint8Array): void {
    if (buf.length !== BLOCK_SIZE) throw new Error(`block write needs ${BLOCK_SIZE} bytes`);
    const at = b * BLOCK_SIZE;
    if (at < 0 || at + BLOCK_SIZE > this.data.length) {
      throw new RangeError(`block write out of range: ${b}`);
    }
    this.data.set(buf, at);
  }
}
