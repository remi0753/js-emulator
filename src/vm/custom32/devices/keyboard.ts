// Keyboard device (v2). An input ring buffer on the port bus. When a key arrives
// it raises an interrupt (here: an `onInput` callback the kernel installs, which
// stands in for the IRQ line); the kernel then delivers bytes to blocked readers.
//
// Reading the data port (IN) returns the next queued byte, or 0 if empty — the
// raw mechanism a guest driver would use. The kernel's stdin path uses the
// higher-level `take`/`available` API plus blocking, since real input is async.

import type { PortDevice } from '../ports.ts';

export class Keyboard implements PortDevice {
  private queue: number[] = [];
  closed = false; // no more input will ever arrive (EOF)
  // The "IRQ": invoked whenever input state changes so the kernel can wake readers.
  onInput: (() => void) | null = null;

  // Queue characters as if typed.
  feed(s: string): void {
    for (let i = 0; i < s.length; i++) this.queue.push(s.charCodeAt(i) & 0xff);
    this.onInput?.();
  }

  // Signal end-of-input (e.g. the host closed stdin); wakes blocked readers.
  close(): void {
    this.closed = true;
    this.onInput?.();
  }

  get available(): number {
    return this.queue.length;
  }

  // Pop up to `n` queued bytes (fewer if the buffer runs out).
  take(n: number): Uint8Array {
    return new Uint8Array(this.queue.splice(0, n));
  }

  // Raw port read (IN): next byte or 0.
  read(_port: number): number {
    if (_port === 0x64) {
      return (this.queue.length > 0 ? 1 : 0) | (this.closed ? 2 : 0);
    }
    return this.queue.shift() ?? 0;
  }
}
