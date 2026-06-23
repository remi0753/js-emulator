// Power-control device (Phase 16). A write-only control register on the port bus
// that lets the guest shut the machine down cleanly -- the software-controlled
// power-off line real platforms expose (e.g. ACPI PM1a_CNT).
//
// Writing POWER_OFF to PORT.POWER powers the machine off: the device records it
// and invokes the `onPowerOff` callback (the Machine wires this to halt the CPU).
// Any other value is ignored, so a stray write does not stop the machine.

import type { PortDevice } from '../ports.ts';

// The command word that triggers shutdown (other values are no-ops).
export const POWER_OFF = 0x2000;

export class Power implements PortDevice {
  // Set once the guest has requested power-off (observable by tests).
  poweredOff = false;
  // Invoked on power-off so the Machine can stop the CPU.
  onPowerOff: (() => void) | null = null;

  write(_port: number, value: number): void {
    if ((value >>> 0) !== POWER_OFF) return;
    this.poweredOff = true;
    this.onPowerOff?.();
  }
}
