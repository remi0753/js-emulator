// Paging MMU (v2). An x86-32-style two-level page table.
//
//   vaddr = [ 10-bit dir index | 10-bit table index | 12-bit offset ]
//
// The page directory and each page table are one page (4 KiB) = 1024 entries
// x 4 bytes. The low 12 bits of an entry are flags, the high 20 bits the frame.

import { PAGE_SIZE, type PhysicalMemory } from './memory.ts';

export const PTE = {
  P: 1 << 0, // present
  W: 1 << 1, // writable
  U: 1 << 2, // user-accessible
  COW: 1 << 9, // software bit: copy-on-write (page is shared read-only; copy on write)
} as const;

export const ENTRIES_PER_TABLE = 1024;
const ADDR_MASK = 0xfffff000; // mask that extracts the frame base address

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
  present: boolean; // false: page not present / true: protection violation
  reason: 'not-present' | 'protection';
}
export type TranslateResult = TranslateOk | TranslateFault;

export interface AccessOptions {
  write: boolean;
  user: boolean; // is this an access from USER mode?
}

export class Mmu {
  private phys: PhysicalMemory;

  constructor(phys: PhysicalMemory) {
    this.phys = phys;
  }

  // Translate vaddr to a physical address using ptbr (the page directory's physical addr).
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

  // Map the page containing vaddr to a physical frame (used by the kernel when
  // building an address space). Allocates a page table via allocFrame() if needed.
  map(ptbr: number, vaddr: number, frame: number, flags: number, allocFrame: () => number): void {
    const pdeAddr = ptbr + dirIndex(vaddr) * 4;
    let pde = this.phys.read32(pdeAddr);
    if ((pde & PTE.P) === 0) {
      const tableFrame = allocFrame();
      this.phys.zeroPage(tableFrame);
      // The directory entry permits broadly; the real permission is enforced by the PTE.
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

// One present mapping discovered by walking a page directory.
export interface PageMapping {
  vaddr: number;
  paddr: number; // frame base (page offset is 0)
  flags: number; // low 12 bits of the PTE (P/W/U/COW)
}

// Walk every present entry of the two-level table rooted at `ptbr` and return the
// virtual->physical mappings. Hardware-visible inspection only; it never faults.
// Used for deterministic page-table dumps (Phase 7 tracing).
export function dumpPageTable(phys: PhysicalMemory, ptbr: number): PageMapping[] {
  const out: PageMapping[] = [];
  for (let di = 0; di < ENTRIES_PER_TABLE; di++) {
    const pde = phys.read32(ptbr + di * 4);
    if ((pde & PTE.P) === 0) continue;
    const tableAddr = pde & ADDR_MASK;
    for (let ti = 0; ti < ENTRIES_PER_TABLE; ti++) {
      const pte = phys.read32(tableAddr + ti * 4);
      if ((pte & PTE.P) === 0) continue;
      const vaddr = ((di << 22) | (ti << 12)) >>> 0;
      out.push({ vaddr, paddr: pte & ADDR_MASK, flags: pte & 0xfff });
    }
  }
  return out;
}

export { PAGE_SIZE };
