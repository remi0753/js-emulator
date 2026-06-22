// Virtual memory manager (v2): builds per-process address spaces and copies
// data across the user/kernel boundary using the MMU, exactly like a real kernel.

import { PAGE_SIZE, type PhysicalMemory } from '../hw/memory.ts';
import { ENTRIES_PER_TABLE, type Mmu, PTE, pageBase } from '../hw/mmu.ts';
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

  // Deep-copy an address space (used by fork): duplicate the page directory, every
  // present page table, and every mapped frame, preserving per-page permissions.
  cloneAddressSpace(srcPd: number): number {
    const dstPd = this.createAddressSpace();
    for (let di = 0; di < ENTRIES_PER_TABLE; di++) {
      const pde = this.phys.read32(srcPd + di * 4);
      if ((pde & PTE.P) === 0) continue;
      const srcTable = pageBase(pde);
      for (let ti = 0; ti < ENTRIES_PER_TABLE; ti++) {
        const pte = this.phys.read32(srcTable + ti * 4);
        if ((pte & PTE.P) === 0) continue;
        const vaddr = (di << 22) | (ti << 12);
        const dstFrame = this.mapPage(dstPd, vaddr, pte & (PTE.U | PTE.W));
        const srcFrame = pageBase(pte);
        this.phys.bytes.copyWithin(dstFrame, srcFrame, srcFrame + PAGE_SIZE);
      }
    }
    return dstPd;
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
    const r = this.mmu.translate(pd, vaddr, { write, user: true });
    if (!r.ok) throw new BadAddress(`bad user address: 0x${vaddr.toString(16)}`);
    return r.paddr;
  }
}

export { PTE };
