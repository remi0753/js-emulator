// Real-time clock device (Phase 16). A read-only wall-clock on the port bus.
//
// Reading PORT.RTC_DATA returns the current time as a 32-bit Unix timestamp in
// whole seconds -- exactly the raw mechanism a guest driver uses to learn the
// time. The clock source is injectable so tests are deterministic: pass a fixed
// number (or a function) at construction; the default reads the host clock.

import type { PortDevice } from '../ports.ts';

export class Rtc implements PortDevice {
  // Returns the current time in whole seconds (Unix epoch).
  private clock: () => number;

  // `clock` is a fixed timestamp (deterministic, for tests) or a function that
  // returns one. The default samples the host wall clock.
  constructor(clock: number | (() => number) = () => Math.floor(Date.now() / 1000)) {
    this.clock = typeof clock === 'number' ? () => clock : clock;
  }

  // Raw port read (IN): the current Unix time in seconds, as a 32-bit word.
  read(_port: number): number {
    return this.clock() >>> 0;
  }
}
