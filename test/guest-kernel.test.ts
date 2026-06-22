import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPhase11KernelImage, PHASE11_KERNEL_LAYOUT } from '../src/v3/guest-kernel.ts';
import { MODE } from '../src/vm/custom32/cpu.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

test('Phase 11: minimal guest kernel owns paging, page faults, timer IRQs, and idle', () => {
  const image = buildPhase11KernelImage();

  let out = '';
  const machine = new Machine({
    physSize: 1024 * 1024,
    consoleSink: (s) => (out += s),
  });
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: PHASE11_KERNEL_LAYOUT.stackTop });

  const r = machine.run(250_000);

  assert.equal(r.reason, 'timer');
  assert.equal(machine.cpu.mode, MODE.KERNEL);
  assert.equal(machine.cpu.pagingEnabled, true);
  assert.equal(machine.cpu.ptbr, PHASE11_KERNEL_LAYOUT.pageDirectory);
  assert.equal(out, 'phase11: boot\nphase11: paging\nphase11: pf\nphase11: idle\n');

  assert.equal(machine.phys.read32(image.symbols.get('pf_count')!), 1);
  assert.equal(machine.phys.read32(image.symbols.get('page_fault_addr')!), PHASE11_KERNEL_LAYOUT.demandVirtual);
  assert.equal(machine.phys.read32(image.symbols.get('page_fault_err')!), 0);
  assert.equal(machine.phys.read32(image.symbols.get('deliberate_value')!), 0x51);
  assert.ok(machine.phys.read32(image.symbols.get('ticks')!) > 0);
  assert.ok(machine.phys.read32(image.symbols.get('idle_count')!) > 0);
});
