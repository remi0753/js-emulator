// Console device (v2). A character output device on the port bus.
//
// Writing a byte to PORT.CONSOLE_DATA emits one character. The kernel's console
// driver talks to it through the same port bus the guest would use.

import type { PortDevice } from '../ports.ts';

export class Console implements PortDevice {
  // Everything written, kept for tests / inspection.
  output = '';
  private sink: (s: string) => void;

  // Pending input bytes (stdin). Until the keyboard arrives (Phase 6), input is
  // pre-fed by the host; a read past the end returns 0 (EOF).
  private inputQueue: number[] = [];

  constructor(sink: (s: string) => void = (s) => process.stdout.write(s)) {
    this.sink = sink;
  }

  write(_port: number, value: number): void {
    const ch = String.fromCharCode(value & 0xff);
    this.output += ch;
    this.sink(ch);
  }

  // Queue characters to be delivered to readers of stdin.
  feedInput(s: string): void {
    for (let i = 0; i < s.length; i++) this.inputQueue.push(s.charCodeAt(i) & 0xff);
  }

  get inputAvailable(): number {
    return this.inputQueue.length;
  }

  // Pop up to `n` queued input bytes (fewer if the queue runs out).
  readInput(n: number): Uint8Array {
    return new Uint8Array(this.inputQueue.splice(0, n));
  }
}
