// 物理 RAM (v2)。1 枚の Uint8Array を全ハードウェアで共有する。
// 仮想アドレス変換は mmu.ts が行い、ここは純粋な物理メモリとして振る舞う。

export const PAGE_SIZE = 4096; // 4 KiB ページ
export const WORD = 4; // 32bit ワード (リトルエンディアン)

export class PhysicalMemory {
  readonly bytes: Uint8Array;
  readonly size: number;

  constructor(size: number) {
    if (size % PAGE_SIZE !== 0) {
      throw new Error(`物理メモリサイズはページ境界 (${PAGE_SIZE}) に揃える必要があります`);
    }
    this.size = size;
    this.bytes = new Uint8Array(size);
  }

  private check(addr: number, n: number): void {
    if (addr < 0 || addr + n > this.size) {
      throw new RangeError(`物理メモリ範囲外: 0x${addr.toString(16)} (+${n})`);
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

  // 1 ページをゼロ埋め (フレーム割り当て時などに使う)。
  zeroPage(physAddr: number): void {
    this.check(physAddr, PAGE_SIZE);
    this.bytes.fill(0, physAddr, physAddr + PAGE_SIZE);
  }
}
