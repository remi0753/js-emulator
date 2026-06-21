// ページング MMU (v2)。x86-32 風の 2 レベルページテーブル。
//
//   vaddr = [ 10bit ディレクトリ索引 | 10bit テーブル索引 | 12bit オフセット ]
//
// ページディレクトリ / ページテーブルはどちらも 1 ページ (4 KiB) = 1024 エントリ
// × 4 byte。エントリ下位 12bit がフラグ、上位 20bit が物理フレーム番号。

import { PAGE_SIZE, type PhysicalMemory } from './memory.ts';

export const PTE = {
  P: 1 << 0, // present
  W: 1 << 1, // writable
  U: 1 << 2, // user-accessible
} as const;

export const ENTRIES_PER_TABLE = 1024;
const ADDR_MASK = 0xfffff000; // フレーム先頭アドレスを取り出すマスク

export function dirIndex(vaddr: number): number {
  return (vaddr >>> 22) & 0x3ff;
}
export function tableIndex(vaddr: number): number {
  return (vaddr >>> 12) & 0x3ff;
}
export function pageOffset(vaddr: number): number {
  return vaddr & 0xfff;
}
export function pageBase(vaddr: number): number {
  return vaddr & ADDR_MASK;
}

export interface TranslateOk {
  ok: true;
  paddr: number;
}
export interface TranslateFault {
  ok: false;
  present: boolean; // false: ページ不在 / true: 権限違反
  reason: 'not-present' | 'protection';
}
export type TranslateResult = TranslateOk | TranslateFault;

export interface AccessOptions {
  write: boolean;
  user: boolean; // USER モードからのアクセスか
}

export class Mmu {
  private phys: PhysicalMemory;

  constructor(phys: PhysicalMemory) {
    this.phys = phys;
  }

  // ptbr (ページディレクトリの物理アドレス) を使って vaddr を物理アドレスへ変換。
  translate(ptbr: number, vaddr: number, opts: AccessOptions): TranslateResult {
    const pde = this.phys.read32(ptbr + dirIndex(vaddr) * 4);
    if ((pde & PTE.P) === 0) return fault('not-present');
    if (opts.user && (pde & PTE.U) === 0) return fault('protection', true);

    const tableAddr = pde & ADDR_MASK;
    const pte = this.phys.read32(tableAddr + tableIndex(vaddr) * 4);
    if ((pte & PTE.P) === 0) return fault('not-present');
    if (opts.user && (pte & PTE.U) === 0) return fault('protection', true);
    if (opts.write && (pte & PTE.W) === 0) return fault('protection', true);

    return { ok: true, paddr: (pte & ADDR_MASK) | pageOffset(vaddr) };
  }

  // vaddr のページを物理フレームへマップする (カーネルがアドレス空間を組むときに使う)。
  // 必要ならページテーブルを allocFrame() で確保する。
  map(ptbr: number, vaddr: number, frame: number, flags: number, allocFrame: () => number): void {
    const pdeAddr = ptbr + dirIndex(vaddr) * 4;
    let pde = this.phys.read32(pdeAddr);
    if ((pde & PTE.P) === 0) {
      const tableFrame = allocFrame();
      this.phys.zeroPage(tableFrame);
      // ディレクトリエントリは配下を広く許可し、実際の権限はページテーブル側で絞る。
      pde = (tableFrame & ADDR_MASK) | PTE.P | PTE.W | PTE.U;
      this.phys.write32(pdeAddr, pde);
    }
    const tableAddr = pde & ADDR_MASK;
    const pteAddr = tableAddr + tableIndex(vaddr) * 4;
    this.phys.write32(pteAddr, (frame & ADDR_MASK) | (flags & 0xfff) | PTE.P);
  }
}

function fault(reason: 'not-present' | 'protection', present = false): TranslateFault {
  return { ok: false, present, reason };
}

export { PAGE_SIZE };
