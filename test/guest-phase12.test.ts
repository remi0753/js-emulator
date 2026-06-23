import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IDT_ENTRY_SIZE, IDT_PRESENT, TIMER_IRQ, TRAP } from '../src/isa.ts';
import { buildPhase12KernelImage, PHASE12_KERNEL_LAYOUT } from '../src/v3/guest-kernel.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

test('Phase 12: guest kernel runs isolated user processes preempted by guest timer IRQs', () => {
  const image = buildPhase12KernelImage();

  let out = '';
  const machine = new Machine({
    physSize: PHASE12_KERNEL_LAYOUT.physSize,
    consoleSink: (s) => (out += s),
  });
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: PHASE12_KERNEL_LAYOUT.kstackTop });

  const r = machine.run(2_000_000);

  // The run only ever returns to the host when the cycle budget runs out: the
  // kernel never halts, it round-robins the user processes inside the timer IRQ.
  assert.equal(r.reason, 'timer');
  assert.equal(machine.cpu.pagingEnabled, true);
  assert.equal(out, 'phase12: boot\nphase12: procs\nphase12: enter user\n');

  const sym = (name: string) => machine.phys.read32(image.symbols.get(name)!);
  const arr = (name: string, i: number) => machine.phys.read32(image.symbols.get(name)! + i * 4);

  // Two independent processes plus a fork of the first.
  assert.equal(sym('nproc'), 3);

  // The guest handled many timer interrupts itself (no TS scheduler involved).
  assert.ok(sym('ticks') > 1, `expected several timer ticks, got ${sym('ticks')}`);

  const frames = [0, 1, 2].map((i) => arr('proc_data_frame', i));
  const counters = frames.map((f) => machine.phys.read32(f));
  const tags = frames.map((f) => machine.phys.read32(f + 4));
  const ptbrs = [0, 1, 2].map((i) => arr('proc_ptbr', i));

  // Every process got CPU time: all three counters advanced. With no TS
  // scheduler, that can only happen if the guest timer handler context-switched
  // between them.
  for (let i = 0; i < 3; i++) {
    assert.ok(counters[i]! > 0, `proc${i} never ran (counter ${counters[i]})`);
  }

  // Isolated address spaces: distinct page directories and distinct physical
  // frames backing the same user virtual data page.
  assert.equal(new Set(ptbrs).size, 3);
  assert.equal(new Set(frames).size, 3);

  // The fork tag each process stamped: proc0/proc1 are independent; proc2 is a
  // fork of proc0, so it carries proc0's tag despite living in its own frames.
  assert.equal(tags[0], 0xa1);
  assert.equal(tags[1], 0xb2);
  assert.equal(tags[2], 0xa1);

  // Each user data page really maps to the frame recorded for that process:
  // walk the live page table the way the MMU does.
  for (let i = 0; i < 3; i++) {
    const pd = ptbrs[i]!;
    const pde = machine.phys.read32(pd + ((PHASE12_KERNEL_LAYOUT.userData >>> 22) & 0x3ff) * 4);
    const ptBase = pde & 0xfffff000;
    const pte = machine.phys.read32(
      ptBase + ((PHASE12_KERNEL_LAYOUT.userData >>> 12) & 0x3ff) * 4,
    );
    assert.equal(pte & 0xfffff000, frames[i]);
    assert.equal(pte & 0x7, 0x7); // present + writable + user
    // Every address space shares the one identity-mapped kernel page table.
    assert.equal(machine.phys.read32(pd) & 0xfffff000, PHASE12_KERNEL_LAYOUT.kernelPageTable);
  }

  // The kernel owns the whole trap path: every vector is present, with the timer
  // and page-fault vectors pointing at their dedicated handlers and all others
  // at the default (panic) handler.
  const timerVector = TRAP.IRQ_BASE + TIMER_IRQ;
  const defaultHandler = sym('default_handler_addr');
  const timerHandler = sym('timer_handler_addr');
  const pfHandler = sym('pf_handler_addr');
  assert.ok(defaultHandler > 0 && timerHandler > 0 && pfHandler > 0);
  for (let vector = 0; vector < 256; vector++) {
    const base = PHASE12_KERNEL_LAYOUT.idt + vector * IDT_ENTRY_SIZE;
    assert.equal(machine.phys.read32(base + 4), IDT_PRESENT);
    const expected =
      vector === timerVector ? timerHandler : vector === TRAP.PAGEFAULT ? pfHandler : defaultHandler;
    assert.equal(machine.phys.read32(base), expected);
  }
});
