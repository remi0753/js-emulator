// Physical RAM (v2). One Uint8Array shared by all hardware.
// Virtual address translation is done by mmu.ts; this is plain physical memory.

export const PAGE_SIZE = 4096; // 4 KiB pages
export const WORD = 4; // 32-bit word (little-endian)

export class PhysicalMemory {
  readonly bytes: Uint8Array;
  readonly size: number;

  constructor(size: number) {
    if (size % PAGE_SIZE !== 0) {
      throw new Error(`physical memory size must be page-aligned (${PAGE_SIZE})`);
    }
    this.size = size;
    this.bytes = new Uint8Array(size);
  }

  private check(addr: number, n: number): void {
    if (addr < 0 || addr + n > this.size) {
      throw new RangeError(`physical memory out of range: 0x${addr.toString(16)} (+${n})`);
    }
  }

  read8(addr: number): number {
    this.check(addr, 1);
    return this.bytes[addr]!;
  }

  write8(addr: number, value: number): void {
    this.check(addr, 1);
    this.bytes[addr] = value & 0xff;
  }

  read32(addr: number): number {
    this.check(addr, WORD);
    const b = this.bytes;
    return (b[addr]! | (b[addr + 1]! << 8) | (b[addr + 2]! << 16) | (b[addr + 3]! << 24)) >>> 0;
  }

  write32(addr: number, value: number): void {
    this.check(addr, WORD);
    const v = value >>> 0;
    const b = this.bytes;
    b[addr] = v & 0xff;
    b[addr + 1] = (v >>> 8) & 0xff;
    b[addr + 2] = (v >>> 16) & 0xff;
    b[addr + 3] = (v >>> 24) & 0xff;
  }

  // Zero a single page (used e.g. when allocating a frame).
  zeroPage(physAddr: number): void {
    this.check(physAddr, PAGE_SIZE);
    this.bytes.fill(0, physAddr, physAddr + PAGE_SIZE);
  }
}
