import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BlockDriver } from '../src/v2/kernel/disk.ts';
import { Fs } from '../src/v2/kernel/fs.ts';
import {
  buildPhase16DiskImage,
  buildPhase16KernelImage,
  PHASE16_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

const RTC_TIME = 1700000000;
const SCRIPT = 'date\nshutdown\n';

const EXPECTED_OUTPUT =
  'phase16: boot\n' +
  'phase16: exec /bin/init\n' +
  `${RTC_TIME}\n` + // date: prints the RTC wall-clock time
  'phase16: shutdown\n'; // shutdown: the power device stops the machine

test('Phase 16: the guest reads the RTC and powers off through device drivers', () => {
  const image = buildPhase16KernelImage();
  const disk = buildPhase16DiskImage();

  let out = '';
  const machine = new Machine({
    physSize: PHASE16_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
    rtcTime: RTC_TIME,
  });
  machine.keyboard.feed(SCRIPT);
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: PHASE16_KERNEL_LAYOUT.kstackTop });

  const r = machine.run(20_000_000);

  // /bin/date read the RTC device through the time() syscall and printed the
  // wall-clock time; /bin/shutdown asked the kernel to power off, which wrote the
  // power-off command to the power device, stopping the machine -- all compiled C
  // driving real device hardware on the guest.
  assert.ok(image.flat.length <= PHASE16_KERNEL_LAYOUT.idt);
  assert.equal(r.reason, 'halt');
  assert.equal(machine.power.poweredOff, true);
  assert.equal(machine.cpu.pagingEnabled, true);
  assert.equal(out, EXPECTED_OUTPUT);
});

test('Phase 16: a fresh disk image contains /bin/date and /bin/shutdown', () => {
  const disk = buildPhase16DiskImage();
  const ports = new PortBus();
  const blk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blk);
  ports.register(PORT.DISK_POS, 1, blk);
  ports.register(PORT.DISK_SECTORS, 1, blk);
  const fs = new Fs(new BlockDriver(ports));
  fs.mount();

  for (const path of ['/bin/init', '/bin/sh', '/bin/date', '/bin/shutdown']) {
    const inum = fs.namei(path);
    assert.ok(inum > 0, `missing ${path}`);
    const bytes = fs.readFile(inum);
    assert.ok(bytes.length > 12, `${path} too small to be an executable`);
    const magic = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
    assert.equal(magic >>> 0, 0x35315850, `${path} missing executable magic`);
  }
});
