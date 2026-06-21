// Virtual memory manager (v2): builds per-process address spaces and copies
// data across the user/kernel boundary using the MMU, exactly like a real kernel.

import { PAGE_SIZE, type PhysicalMemory } from '../hw/memory.ts';
import { type Mmu, PTE, pageBase } from '../hw/mmu.ts';
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
    if (vaddr % PAGE_SIZE !== 0) throw new Error('loadImage: vaddr must be page-aligned');
    for (let off = 0; off < bytes.length; off += PAGE_SIZE) {
      const frame = this.mapPage(pd, vaddr + off, flags);
      const chunk = bytes.subarray(off, Math.min(off + PAGE_SIZE, bytes.length));
      this.phys.bytes.set(chunk, frame);
    }
  }

  // Copy `len` bytes out of user space (user vaddr -> kernel Uint8Array).
  copyin(pd: number, vaddr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = this.phys.read8(this.xlate(pd, vaddr + i, false));
    }
    return out;
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
