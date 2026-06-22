// Console device (v2). A character output device on the port bus.
//
// Writing a byte to PORT.CONSOLE_DATA emits one character. The kernel's console
// driver talks to it through the same port bus the guest would use.

import type { PortDevice } from '../ports.ts';

export class Console implements PortDevice {
  // Everything written, kept for tests / inspection.
  output = '';
  private sink: (s: string) => void;

  constructor(sink: (s: string) => void = (s) => process.stdout.write(s)) {
    this.sink = sink;
  }

  write(_port: number, value: number): void {
    const ch = String.fromCharCode(value & 0xff);
    this.output += ch;
    this.sink(ch);
  }
}
