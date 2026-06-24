import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import {
  buildGuestDiskImage,
  buildGuestKernelImage,
  buildUserExecutable,
  GUEST_EXECUTABLE_MAGIC,
  GUEST_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

const RTC_TIME = 1700000000;
const SCRIPT = 'date\nshutdown\n';

const EXPECTED_OUTPUT =
  'kernel: boot\n' +
  'kernel: exec /bin/init\n' +
  `${RTC_TIME}\n` + // date: prints the RTC wall-clock time
  'kernel: shutdown\n'; // shutdown: the power device stops the machine

test('the guest reads the RTC and powers off through device drivers', () => {
  const image = buildGuestKernelImage();
  const disk = buildGuestDiskImage();

  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
    rtcTime: RTC_TIME,
  });
  machine.keyboard.feed(SCRIPT);
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  const r = machine.run(20_000_000);

  // /bin/date read the RTC device through the time() syscall and printed the
  // wall-clock time; /bin/shutdown asked the kernel to power off, which wrote the
  // power-off command to the power device, stopping the machine -- all compiled C
  // driving real device hardware on the guest.
  assert.ok(image.flat.length <= GUEST_KERNEL_LAYOUT.idt);
  assert.equal(r.reason, 'halt');
  assert.equal(machine.power.poweredOff, true);
  assert.equal(machine.cpu.pagingEnabled, true);
  assert.equal(out, EXPECTED_OUTPUT);
});

test('a fresh disk image contains the device utilities', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blk);
  ports.register(PORT.DISK_POS, 1, blk);
  ports.register(PORT.DISK_SECTORS, 1, blk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();

  for (const path of ['/bin/init', '/bin/sh', '/bin/date', '/bin/shutdown']) {
    const inum = fs.namei(path);
    assert.ok(inum > 0, `missing ${path}`);
    const bytes = fs.readFile(inum);
    assert.ok(bytes.length > 12, `${path} too small to be an executable`);
    const magic = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
    assert.equal(magic >>> 0, GUEST_EXECUTABLE_MAGIC, `${path} missing executable magic`);
  }
});

test('bad user inputs return errors without panicking the kernel', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blk);
  ports.register(PORT.DISK_POS, 1, blk);
  ports.register(PORT.DISK_SECTORS, 1, blk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(
    '/bin/probe',
    buildUserExecutable(
      'probe',
      `
        char big[600];
        char *av[2];
        int main(int argc, char **argv) {
          int i;
          if (__syscall(999, 0, 0, 0) >= 0) return 1; // unknown syscall -> -ENOSYS
          if (write(1, 0x700000, 4) != -1) return 2;
          if (write(1, 0x7ffff0, 0x7fffffff) != -1) return 3;
          if (exec("/missing", 0) != -1) return 4;
          i = 0;
          while (i < 600) { big[i] = 'A'; i = i + 1; }
          av[0] = big;
          av[1] = 0;
          if (exec("/bin/echo", av) != -1) return 5;
          write(1, "safe\\n", 5);
          return 0;
        }
      `,
    ),
  );
  fs.chmod('/bin/probe', 0o755);
  fs.writeFile('/bad', new TextEncoder().encode('not an executable'));

  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
    rtcTime: RTC_TIME,
  });
  machine.keyboard.feed('probe\n/bad\necho survived\nshutdown\n');
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  const r = machine.run(40_000_000);

  assert.equal(r.reason, 'halt');
  assert.equal(out.includes('PANIC'), false);
  assert.equal(out.includes('safe\n'), true);
  assert.equal(out.includes('sh: exec failed\n'), true);
  assert.equal(out.includes('survived\n'), true);
  assert.equal(machine.power.poweredOff, true);
});

test('a large pipeline transfers every byte across a blocking pipe', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blk);
  ports.register(PORT.DISK_POS, 1, blk);
  ports.register(PORT.DISK_SECTORS, 1, blk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  const count = 20_000;
  fs.writeFile('/big', new TextEncoder().encode(`${'X'.repeat(count)}\n`));

  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
    rtcTime: RTC_TIME,
  });
  machine.keyboard.feed('cat /big | cat\nshutdown\n');
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  const r = machine.run(100_000_000);

  assert.equal(r.reason, 'halt');
  assert.equal((out.match(/X/g) ?? []).length, count);
  assert.equal(machine.power.poweredOff, true);
});
