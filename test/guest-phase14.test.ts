import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IDT_ENTRY_SIZE, IDT_PRESENT, SYSCALL_INT, TIMER_IRQ, TRAP } from '../src/isa.ts';
import {
  buildPhase14DiskImage,
  buildPhase14KernelImage,
  PHASE14_EXPECTED_OUTPUT,
  PHASE14_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

test('Phase 14: guest kernel mounts the FS, loads /bin/init from disk, and runs file I/O in guest code', () => {
  const image = buildPhase14KernelImage();
  const disk = buildPhase14DiskImage();

  let out = '';
  const machine = new Machine({
    physSize: PHASE14_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
  });
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: PHASE14_KERNEL_LAYOUT.kstackTop });

  const r = machine.run(5_000_000);

  // The guest mounted the disk image, loaded /bin/init from the filesystem and
  // exec'd it, init opened/read/printed /etc/motd through file descriptors,
  // forked a child that exec'd /bin/hello (also loaded from the FS), waited for
  // it, and every process exited -- all with no TypeScript FS or syscall code.
  assert.ok(image.flat.length <= PHASE14_KERNEL_LAYOUT.idt);
  assert.equal(r.reason, 'halt');
  assert.equal(machine.cpu.pagingEnabled, true);
  assert.equal(out, PHASE14_EXPECTED_OUTPUT);

  const sym = (name: string) => machine.phys.read32(image.symbols.get(name)!);

  // The superblock was mounted from disk: xv6 layout has inodes right after the
  // boot block + superblock (block 2), and 200 inodes by default.
  assert.equal(sym('fs_inodestart'), 2);
  assert.equal(sym('fs_ninodes'), 200);

  // Two processes ran: init (slot 0) and its forked child that exec'd /bin/hello.
  assert.equal(sym('nproc'), 2);

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
    const base = PHASE14_KERNEL_LAYOUT.idt + vector * IDT_ENTRY_SIZE;
    assert.equal(machine.phys.read32(base + 4), IDT_PRESENT);
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
