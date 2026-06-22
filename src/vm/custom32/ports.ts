// Port I/O bus (v2). Attaches devices at fixed port numbers.
//
// Both the CPU's privileged IN/OUT instructions and the TS kernel drivers talk
// to devices through this same bus (so the port I/O mechanism is exercised end
// to end).

export interface PortDevice {
  // Read from a port (IN). Returns a 32-bit value.
  read?(port: number): number;
  // Write to a port (OUT).
  write?(port: number, value: number): void;
}

export class PortBus {
  // port number -> device
  private readers = new Map<number, PortDevice>();
  private writers = new Map<number, PortDevice>();

  // Optional deterministic trace hook (off by default; the Tracer wires it).
  onIo: ((dir: 'in' | 'out', port: number, value: number) => void) | null = null;

  // Assign a device to the port range [base, base+count).
  register(base: number, count: number, device: PortDevice): void {
    for (let p = base; p < base + count; p++) {
      if (device.read) this.readers.set(p, device);
      if (device.write) this.writers.set(p, device);
    }
  }

  in(port: number): number {
    const dev = this.readers.get(port);
    if (!dev?.read) throw new PortError(`IN from an unwired port: 0x${port.toString(16)}`);
    const value = dev.read(port) >>> 0;
    this.onIo?.('in', port, value);
    return value;
  }

  out(port: number, value: number): void {
    const dev = this.writers.get(port);
    if (!dev?.write) throw new PortError(`OUT to an unwired port: 0x${port.toString(16)}`);
    const v = value >>> 0;
    dev.write(port, v);
    this.onIo?.('out', port, v);
  }
}

export class PortError extends Error {}
