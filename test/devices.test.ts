import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { Power, POWER_OFF } from '../src/vm/custom32/devices/power.ts';
import { Rtc } from '../src/vm/custom32/devices/rtc.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

// --- RTC device (Phase 16) ---

test('RTC: reading the data port returns the configured Unix time', () => {
  const ports = new PortBus();
  ports.register(PORT.RTC_DATA, 1, new Rtc(1700000000));
  assert.equal(ports.in(PORT.RTC_DATA), 1700000000);
});

test('RTC: a clock function is sampled on each read', () => {
  let now = 100;
  const ports = new PortBus();
  ports.register(PORT.RTC_DATA, 1, new Rtc(() => now));
  assert.equal(ports.in(PORT.RTC_DATA), 100);
  now = 250;
  assert.equal(ports.in(PORT.RTC_DATA), 250);
});

// --- Power device (Phase 16) ---

test('Power: writing POWER_OFF asserts power-off and fires the callback', () => {
  let fired = 0;
  const power = new Power();
  power.onPowerOff = () => fired++;
  const ports = new PortBus();
  ports.register(PORT.POWER, 1, power);

  ports.out(PORT.POWER, POWER_OFF);
  assert.equal(power.poweredOff, true);
  assert.equal(fired, 1);
});

test('Power: an unrelated value is ignored', () => {
  let fired = 0;
  const power = new Power();
  power.onPowerOff = () => fired++;
  const ports = new PortBus();
  ports.register(PORT.POWER, 1, power);

  ports.out(PORT.POWER, 0x1);
  assert.equal(power.poweredOff, false);
  assert.equal(fired, 0);
});

// --- CPU power-off line: an OUT to the power port stops the machine ---

test('Machine: an OUT of POWER_OFF to the power port halts run()', () => {
  const machine = new Machine({ physSize: 64 * 1024 });
  const { bytes } = assemble(`
    MOV R1, ${PORT.POWER}
    MOV R2, ${POWER_OFF}
    OUT R1, R2        ; assert the power-off line
    MOV R0, 123       ; would run if the machine did not stop
    HLT
  `);
  machine.load(0, bytes);
  machine.reset();

  const r = machine.run(100);

  // The power device stopped the CPU before the instruction after OUT ran.
  assert.equal(r.reason, 'halt');
  assert.equal(machine.power.poweredOff, true);
  assert.equal(machine.cpu.regs[0], 0); // MOV R0, 123 never executed
});

test('BlockDisk rejects out-of-range sectors and streaming past the image', () => {
  const disk = BlockDisk.blank(1);
  assert.throws(() => disk.write(PORT.DISK_POS, 1), /sector out of range/);
  disk.write(PORT.DISK_POS, 0);
  for (let i = 0; i < 128; i++) disk.read(PORT.DISK_DATA);
  assert.throws(() => disk.read(PORT.DISK_DATA), /word access out of range/);
});
