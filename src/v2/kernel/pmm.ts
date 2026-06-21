// Physical memory manager (v2): a free-frame allocator over physical RAM.
//
// Frames are 4 KiB. A simple free list of frame base addresses; alloc() pops one
// and free() pushes it back. The low region below `base` is left reserved.

import { PAGE_SIZE, type PhysicalMemory } from '../hw/memory.ts';

export class Pmm {
  private free: number[] = [];
  readonly base: number;
  readonly total: number;

  // Manage frames in [base, phys.size). `base` must be page-aligned.
  constructor(phys: PhysicalMemory, base: number) {
    if (base % PAGE_SIZE !== 0) throw new Error('pmm base must be page-aligned');
    this.base = base;
    // Build the free list high-to-low so the first allocations are low addresses.
    for (let addr = phys.size - PAGE_SIZE; addr >= base; addr -= PAGE_SIZE) {
      this.free.push(addr);
    }
    this.total = this.free.length;
  }

  get freeCount(): number {
    return this.free.length;
  }

  // Allocate one frame; returns its physical base address.
  alloc(): number {
    const frame = this.free.pop();
    if (frame === undefined) throw new Error('out of physical memory');
    return frame;
  }

  free_(frame: number): void {
    this.free.push(frame);
  }
}
