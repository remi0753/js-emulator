import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BlockDriver } from '../src/v2/kernel/disk.ts';
import { Fs } from '../src/v2/kernel/fs.ts';
import {
  buildPhase15DiskImage,
  buildPhase15KernelImage,
  PHASE15_KERNEL_LAYOUT,
  PHASE15_MOTD,
} from '../src/v3/guest-kernel.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

const SCRIPT = 'echo hi\nls /\ncat /etc/motd\ncat /etc/motd | cat\n';

const EXPECTED_OUTPUT =
  'phase15: boot\n' +
  'phase15: exec /bin/init\n' +
  'hi\n' + // echo hi
  '.\n..\nbin\netc\n' + // ls /
  PHASE15_MOTD + // cat /etc/motd
  PHASE15_MOTD + // cat /etc/motd | cat
  'phase15: all processes exited\n';

test('Phase 15: a compiled userland boots and the shell runs echo/ls/cat and a pipeline', () => {
  const image = buildPhase15KernelImage();
  const disk = buildPhase15DiskImage();

  let out = '';
  const machine = new Machine({
    physSize: PHASE15_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
  });
  machine.keyboard.feed(SCRIPT);
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: PHASE15_KERNEL_LAYOUT.kstackTop });

  const r = machine.run(20_000_000);

  // The kernel booted compiled /bin/init from disk, which spawned /bin/sh; the
  // shell ran echo, ls, cat, and the `cat | cat` pipeline -- all compiled C on
  // the guest -- then end-of-input ended the shell and the kernel halted.
  assert.ok(image.flat.length <= PHASE15_KERNEL_LAYOUT.idt);
  assert.equal(r.reason, 'halt');
  assert.equal(machine.cpu.pagingEnabled, true);
  assert.equal(out, EXPECTED_OUTPUT);
});

test('Phase 15: a fresh disk image contains the compiled userland under /bin', () => {
  const disk = buildPhase15DiskImage();
  const ports = new PortBus();
  const blk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blk);
  ports.register(PORT.DISK_POS, 1, blk);
  ports.register(PORT.DISK_SECTORS, 1, blk);
  const fs = new Fs(new BlockDriver(ports));
  fs.mount();

  for (const path of ['/bin/init', '/bin/sh', '/bin/echo', '/bin/cat', '/bin/ls']) {
    const inum = fs.namei(path);
    assert.ok(inum > 0, `missing ${path}`);
    const bytes = fs.readFile(inum);
    // Each is a compiled guest executable: a 12-byte header then the image.
    assert.ok(bytes.length > 12, `${path} too small to be an executable`);
    const magic = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
    assert.equal(magic >>> 0, 0x35315850, `${path} missing executable magic`);
  }
});
