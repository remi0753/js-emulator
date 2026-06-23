import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IDT_ENTRY_SIZE,
  IDT_PRESENT,
  IDT_USER,
  SYSCALL_INT,
  TIMER_IRQ,
  TRAP,
} from '../src/isa.ts';
import {
  buildPhase13KernelImage,
  PHASE13_CHILD_EXIT_CODE,
  PHASE13_EXPECTED_OUTPUT,
  PHASE13_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

test('Phase 13: guest kernel handles the syscall ABI and process lifecycle (fork/exec/wait/print)', () => {
  const image = buildPhase13KernelImage();

  let out = '';
  const machine = new Machine({
    physSize: PHASE13_KERNEL_LAYOUT.physSize,
    consoleSink: (s) => (out += s),
  });
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: PHASE13_KERNEL_LAYOUT.kstackTop });

  const r = machine.run(2_000_000);

  // init forked a child, the child exec'd a second image and printed, init
  // wait()ed for it and printed, then every process exited and the guest kernel
  // halted -- all through INT 0x80 with no TypeScript syscall dispatch.
  assert.ok(image.flat.length <= PHASE13_KERNEL_LAYOUT.idt);
  assert.equal(r.reason, 'halt');
  assert.equal(machine.cpu.pagingEnabled, true);
  assert.equal(out, PHASE13_EXPECTED_OUTPUT);

  const sym = (name: string) => machine.phys.read32(image.symbols.get(name)!);
  const arr = (name: string, i: number) => machine.phys.read32(image.symbols.get(name)! + i * 4);

  // Two processes ever existed: init (slot 0) and its forked child (slot 1).
  assert.equal(sym('nproc'), 2);

  // The fork produced distinct, isolated address spaces for parent and child.
  assert.notEqual(arr('proc_ptbr', 0), arr('proc_ptbr', 1));

  // The guest kernel recorded the child's exit code via the exit() syscall.
  assert.equal(arr('proc_exit_code', 1), PHASE13_CHILD_EXIT_CODE);

  // Both processes ended: init is a zombie with no parent to reap it (state 2),
  // and the child was reaped by init's wait() (state 0 = unused).
  assert.equal(arr('proc_state', 0), 2);
  assert.equal(arr('proc_state', 1), 0);
  assert.equal(arr('proc_parent', 1), 0); // the child's parent is init

  // The kernel owns the whole trap path: every vector is present, with the
  // timer, page-fault, and INT 0x80 syscall vectors pointing at their dedicated
  // handlers and all others at the default (panic) handler.
  const timerVector = TRAP.IRQ_BASE + TIMER_IRQ;
  const defaultHandler = sym('default_handler_addr');
  const timerHandler = sym('timer_handler_addr');
  const pfHandler = sym('pf_handler_addr');
  const syscallHandler = sym('syscall_handler_addr');
  assert.ok(defaultHandler > 0 && timerHandler > 0 && pfHandler > 0 && syscallHandler > 0);
  for (let vector = 0; vector < 256; vector++) {
    const base = PHASE13_KERNEL_LAYOUT.idt + vector * IDT_ENTRY_SIZE;
    assert.equal(
      machine.phys.read32(base + 4),
      vector === SYSCALL_INT ? IDT_PRESENT | IDT_USER : IDT_PRESENT,
    );
    const expected =
      vector === timerVector
        ? timerHandler
        : vector === TRAP.PAGEFAULT
          ? pfHandler
          : vector === SYSCALL_INT
            ? syscallHandler
            : defaultHandler;
    assert.equal(machine.phys.read32(base), expected);
  }
});
