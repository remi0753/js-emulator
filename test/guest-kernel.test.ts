import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IDT_ENTRY_SIZE, IDT_PRESENT, PF_ERR } from '../src/isa.ts';
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

  const sym = (name: string) => machine.phys.read32(image.symbols.get(name)!);

  // The deliberate fault was a write to an unmapped, non-user page.
  assert.equal(sym('pf_count'), 1);
  assert.equal(sym('page_fault_addr'), PHASE11_KERNEL_LAYOUT.demandVirtual);
  assert.equal(sym('page_fault_err'), PF_ERR.WRITE);
  assert.equal(sym('deliberate_value'), 0x51);

  // The page-fault handler allocated exactly one frame and mapped the faulting
  // page to it (present + writable). Verify the live page-table entry.
  const expectedFrame = PHASE11_KERNEL_LAYOUT.framePoolBase;
  assert.equal(sym('next_frame'), PHASE11_KERNEL_LAYOUT.framePoolBase + 4096);
  const pteAddr =
    PHASE11_KERNEL_LAYOUT.pageTable0 + ((PHASE11_KERNEL_LAYOUT.demandVirtual >>> 12) & 0x3ff) * 4;
  assert.equal(machine.phys.read32(pteAddr), (expectedFrame | 3) >>> 0);

  // The kernel owns the whole trap path: every other vector points at the
  // default (panic) handler so an unexpected trap stays in the guest.
  const defaultHandler = sym('default_handler_addr');
  assert.ok(defaultHandler > 0);
  for (const vector of [1, 6, 13, 100, 0x80, 255]) {
    const base = PHASE11_KERNEL_LAYOUT.idt + vector * IDT_ENTRY_SIZE;
    assert.equal(machine.phys.read32(base), defaultHandler);
    assert.equal(machine.phys.read32(base + 4), IDT_PRESENT);
  }

  assert.ok(sym('ticks') > 0);
  assert.ok(sym('idle_count') > 0);
});
