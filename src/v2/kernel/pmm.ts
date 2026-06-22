// Physical memory manager (v2): a free-frame allocator over physical RAM.
//
// Frames are 4 KiB. A simple free list of frame base addresses; alloc() pops one
// and free() pushes it back. The low region below `base` is left reserved.

import { PAGE_SIZE, type PhysicalMemory } from '../hw/memory.ts';

export class Pmm {
  private free: number[] = [];
  // Per-frame reference counts. A frame can be shared by several address spaces
  // (copy-on-write fork), so it is only returned to the free list when the last
  // reference is dropped.
  private refs = new Map<number, number>();
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

  // Allocate one frame (refcount 1); returns its physical base address.
  alloc(): number {
    const frame = this.free.pop();
    if (frame === undefined) throw new Error('out of physical memory');
    this.refs.set(frame, 1);
    return frame;
  }

  // Add a reference to a frame (used when a frame becomes shared on COW fork).
  incref(frame: number): void {
    this.refs.set(frame, (this.refs.get(frame) ?? 1) + 1);
  }

  // Current reference count of a frame.
  refcount(frame: number): number {
    return this.refs.get(frame) ?? 0;
  }

  // Drop a reference; the frame is freed only when its last reference goes away.
  free_(frame: number): void {
    const c = (this.refs.get(frame) ?? 1) - 1;
    if (c <= 0) {
      this.refs.delete(frame);
      this.free.push(frame);
    } else {
      this.refs.set(frame, c);
    }
  }
}
