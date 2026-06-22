// Virtual memory manager (v2): builds per-process address spaces and copies
// data across the user/kernel boundary using the MMU, exactly like a real kernel.

import { PAGE_SIZE, type PhysicalMemory } from '../../vm/custom32/memory.ts';
import {
  dirIndex,
  ENTRIES_PER_TABLE,
  type Mmu,
  PTE,
  pageBase,
  tableIndex,
} from '../../vm/custom32/mmu.ts';
import type { Pmm } from './pmm.ts';

// Thrown when a user-supplied pointer doesn't translate (bad syscall argument).
// The syscall layer turns this into an error return instead of crashing.
export class BadAddress extends Error {}

export class Vmm {
  private phys: PhysicalMemory;
  private mmu: Mmu;
  private pmm: Pmm;

  constructor(phys: PhysicalMemory, mmu: Mmu, pmm: Pmm) {
    this.phys = phys;
    this.mmu = mmu;
    this.pmm = pmm;
  }

  // Create a fresh, empty address space; returns the page-directory phys addr.
  createAddressSpace(): number {
    const pd = this.pmm.alloc();
    this.phys.zeroPage(pd);
    return pd;
  }

  // Map one page at `vaddr` to a freshly allocated, zeroed frame; returns the frame.
  mapPage(pd: number, vaddr: number, flags: number): number {
    const frame = this.pmm.alloc();
    this.phys.zeroPage(frame);
    this.mmu.map(pd, pageBase(vaddr), frame, flags, () => {
      const t = this.pmm.alloc();
      this.phys.zeroPage(t);
      return t;
    });
    return frame;
  }

  // Map enough pages to hold `bytes` starting at `vaddr` (page-aligned) and copy
  // the image in. Used by the loader for a program's text/data.
  loadImage(pd: number, vaddr: number, bytes: Uint8Array, flags: number): void {
    this.loadSegment(pd, vaddr, bytes, bytes.length, flags);
  }

  // Map `memSize` bytes at `vaddr` (page-aligned), copy `data` (fileSize bytes)
  // in, and leave the rest zero-filled (BSS). Used by the executable loader.
  loadSegment(pd: number, vaddr: number, data: Uint8Array, memSize: number, flags: number): void {
    if (vaddr % PAGE_SIZE !== 0) throw new Error('loadSegment: vaddr must be page-aligned');
    const total = Math.max(memSize, data.length);
    for (let off = 0; off < total; off += PAGE_SIZE) {
      const frame = this.mapPage(pd, vaddr + off, flags); // freshly zeroed -> BSS is zero
      if (off < data.length) {
        const chunk = data.subarray(off, Math.min(off + PAGE_SIZE, data.length));
        this.phys.bytes.set(chunk, frame);
      }
    }
  }

  // Copy-on-write clone of an address space (used by fork). Page tables are
  // duplicated, but data frames are *shared* read-only between parent and child:
  // both PTEs lose write permission and gain the COW bit, and the frame's
  // reference count is bumped. The first write to such a page faults and is
  // resolved by tryCow(), which makes a private copy.
  cowCloneAddressSpace(srcPd: number): number {
    const dstPd = this.createAddressSpace();
    for (let di = 0; di < ENTRIES_PER_TABLE; di++) {
      const pde = this.phys.read32(srcPd + di * 4);
      if ((pde & PTE.P) === 0) continue;
      const srcTable = pageBase(pde);
      for (let ti = 0; ti < ENTRIES_PER_TABLE; ti++) {
        const pteAddr = srcTable + ti * 4;
        const pte = this.phys.read32(pteAddr);
        if ((pte & PTE.P) === 0) continue;
        const frame = pageBase(pte);
        // Shared, read-only, COW. Keep U; drop W; add COW.
        const cowFlags = ((pte & 0xfff & ~PTE.W) | PTE.COW) & 0xfff;
        this.phys.write32(pteAddr, frame | cowFlags); // remap the parent's page
        this.mmu.map(dstPd, (di << 22) | (ti << 12), frame, cowFlags, () => {
          const t = this.pmm.alloc();
          this.phys.zeroPage(t);
          return t;
        });
        this.pmm.incref(frame); // now referenced by both address spaces
      }
    }
    return dstPd;
  }

  // Resolve a copy-on-write fault at `vaddr`: give the address space its own
  // writable copy of the shared frame. Returns false if the page is not COW.
  tryCow(pd: number, vaddr: number): boolean {
    const pde = this.phys.read32(pd + dirIndex(vaddr) * 4);
    if ((pde & PTE.P) === 0) return false;
    const pteAddr = pageBase(pde) + tableIndex(vaddr) * 4;
    const pte = this.phys.read32(pteAddr);
    if ((pte & PTE.P) === 0 || (pte & PTE.COW) === 0) return false;

    const oldFrame = pageBase(pte);
    const flags = (pte & 0xfff & ~PTE.COW) | PTE.W; // writable, no longer COW
    if (this.pmm.refcount(oldFrame) <= 1) {
      // We are the last owner: just take the page back, no copy needed.
      this.phys.write32(pteAddr, oldFrame | flags);
      return true;
    }
    const newFrame = this.pmm.alloc();
    this.phys.bytes.copyWithin(newFrame, oldFrame, oldFrame + PAGE_SIZE);
    this.phys.write32(pteAddr, newFrame | flags);
    this.pmm.free_(oldFrame); // drop our reference to the shared frame
    return true;
  }

  // Tear down an address space (used by exit/exec): free every mapped frame, then
  // every page table, then the page directory itself, returning them to the pmm.
  freeAddressSpace(pd: number): void {
    for (let di = 0; di < ENTRIES_PER_TABLE; di++) {
      const pde = this.phys.read32(pd + di * 4);
      if ((pde & PTE.P) === 0) continue;
      const table = pageBase(pde);
      for (let ti = 0; ti < ENTRIES_PER_TABLE; ti++) {
        const pte = this.phys.read32(table + ti * 4);
        if ((pte & PTE.P) === 0) continue;
        this.pmm.free_(pageBase(pte));
      }
      this.pmm.free_(table);
    }
    this.pmm.free_(pd);
  }

  // Copy `len` bytes out of user space (user vaddr -> kernel Uint8Array).
  copyin(pd: number, vaddr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = this.phys.read8(this.xlate(pd, vaddr + i, false));
    }
    return out;
  }

  // Read a NUL-terminated string out of user space (for path arguments).
  copyinStr(pd: number, vaddr: number, max = 256): string {
    let s = '';
    for (let i = 0; i < max; i++) {
      const b = this.phys.read8(this.xlate(pd, vaddr + i, false));
      if (b === 0) return s;
      s += String.fromCharCode(b);
    }
    throw new BadAddress(`unterminated string at 0x${vaddr.toString(16)}`);
  }

  // Copy bytes into user space (kernel data -> user vaddr).
  copyout(pd: number, vaddr: number, data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      this.phys.write8(this.xlate(pd, vaddr + i, true), data[i]!);
    }
  }

  private xlate(pd: number, vaddr: number, write: boolean): number {
    let r = this.mmu.translate(pd, vaddr, { write, user: true });
    // A kernel write to a copy-on-write page resolves the COW and retries, just
    // like a faulting user write would — so copyout never trips over a shared page.
    if (!r.ok && write && this.tryCow(pd, vaddr)) {
      r = this.mmu.translate(pd, vaddr, { write, user: true });
    }
    if (!r.ok) throw new BadAddress(`bad user address: 0x${vaddr.toString(16)}`);
    return r.paddr;
  }
}

export { PTE };
