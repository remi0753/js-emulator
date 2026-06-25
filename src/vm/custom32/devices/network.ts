import type { PortDevice } from '../ports.ts';

export const NETWORK_MAX_FRAME = 1518;

// A small PIO Ethernet NIC. Frames are queued by the host, consumed byte by
// byte by the guest, and transmitted frames are retained for deterministic
// tests. Writing TX_LEN starts a frame; the frame is committed after that many
// bytes have been written to TX_DATA.
export class NetworkCard implements PortDevice {
  private readonly ports: {
    status: number;
    rxLength: number;
    rxData: number;
    txLength: number;
    txData: number;
  };
  private readonly receiveQueue: Uint8Array[] = [];
  private receiveOffset = 0;
  private transmitLength = 0;
  private transmitBytes: number[] = [];
  private readonly transmitted: Uint8Array[] = [];

  onReceive: (() => void) | null = null;
  onTransmit: ((frame: Uint8Array) => void) | null = null;

  constructor(ports: {
    status: number;
    rxLength: number;
    rxData: number;
    txLength: number;
    txData: number;
  }) {
    this.ports = ports;
  }

  inject(frame: Uint8Array): void {
    if (frame.length === 0 || frame.length > NETWORK_MAX_FRAME) {
      throw new RangeError(`network frame length must be 1..${NETWORK_MAX_FRAME}`);
    }
    this.receiveQueue.push(frame.slice());
    this.onReceive?.();
  }

  takeTransmitted(): Uint8Array[] {
    return this.transmitted.splice(0);
  }

  get pendingReceiveFrames(): number {
    return this.receiveQueue.length;
  }

  read(port: number): number {
    const frame = this.receiveQueue[0];
    if (port === this.ports.status) return frame ? 1 : 0;
    if (port === this.ports.rxLength) return frame?.length ?? 0;
    if (port === this.ports.rxData) {
      if (!frame) return 0;
      const value = frame[this.receiveOffset++] ?? 0;
      if (this.receiveOffset >= frame.length) {
        this.receiveQueue.shift();
        this.receiveOffset = 0;
      }
      return value;
    }
    return 0;
  }

  write(port: number, value: number): void {
    if (port === this.ports.txLength) {
      if (value <= 0 || value > NETWORK_MAX_FRAME) {
        this.transmitLength = 0;
        this.transmitBytes = [];
        return;
      }
      this.transmitLength = value;
      this.transmitBytes = [];
      return;
    }
    if (port !== this.ports.txData || this.transmitLength === 0) return;
    this.transmitBytes.push(value & 0xff);
    if (this.transmitBytes.length === this.transmitLength) {
      const frame = Uint8Array.from(this.transmitBytes);
      this.transmitted.push(frame);
      this.onTransmit?.(frame.slice());
      this.transmitLength = 0;
      this.transmitBytes = [];
    }
  }
}
