// Entropy device (Phase 26). A read-only random-byte source on the port bus,
// the hardware behind /dev/random and /dev/urandom.
//
// Reading PORT.ENTROPY returns the next pseudo-random byte. The generator is a
// small deterministic xorshift seeded at construction, so emulator tests stay
// reproducible (the VM's whole testing model is deterministic). Pass a fixed
// seed for repeatable bytes, or a host-derived seed for variety.

import type { PortDevice } from '../ports.ts';

const DEFAULT_SEED = 0x9e3779b9; // any nonzero constant; xorshift must avoid 0

export class Entropy implements PortDevice {
  private state: number;

  // `seed` is the initial xorshift state; it must be nonzero (zero is remapped
  // to the default so a 0 seed still produces a stream).
  constructor(seed: number = DEFAULT_SEED) {
    this.state = (seed >>> 0) || DEFAULT_SEED;
  }

  // Raw port read (IN): the next pseudo-random byte (0..255) in the low 8 bits.
  read(_port: number): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state & 0xff;
  }
}
