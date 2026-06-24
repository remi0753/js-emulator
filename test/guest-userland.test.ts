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
  GUEST_MOTD,
} from '../src/v3/guest-kernel.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

const SCRIPT = 'echo hi\nls /\ncat /etc/motd\ncat /etc/motd | cat\n';

const EXPECTED_OUTPUT =
  'kernel: boot\n' +
  'kernel: exec /bin/init\n' +
  'hi\n' + // echo hi
  '.\n..\nbin\netc\n' + // ls /
  GUEST_MOTD + // cat /etc/motd
  GUEST_MOTD + // cat /etc/motd | cat
  'kernel: all processes exited\n';

test('the compiled userland boots and the shell runs echo/ls/cat and a pipeline', () => {
  const image = buildGuestKernelImage();
  const disk = buildGuestDiskImage();

  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
  });
  machine.keyboard.feed(SCRIPT);
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  const r = machine.run(20_000_000);

  // The kernel booted compiled /bin/init from disk, which spawned /bin/sh; the
  // shell ran echo, ls, cat, and the `cat | cat` pipeline -- all compiled C on
  // the guest -- then end-of-input ended the shell and the kernel halted.
  assert.ok(image.flat.length <= GUEST_KERNEL_LAYOUT.idt);
  assert.equal(r.reason, 'halt');
  assert.equal(machine.cpu.pagingEnabled, true);
  assert.equal(out, EXPECTED_OUTPUT);
});

test('a fresh disk image contains the compiled userland under /bin', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blk);
  ports.register(PORT.DISK_POS, 1, blk);
  ports.register(PORT.DISK_SECTORS, 1, blk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();

  for (const path of ['/bin/init', '/bin/sh', '/bin/echo', '/bin/cat', '/bin/ls']) {
    const inum = fs.namei(path);
    assert.ok(inum > 0, `missing ${path}`);
    const bytes = fs.readFile(inum);
    // Each is a compiled guest executable: a 12-byte header then the image.
    assert.ok(bytes.length > 12, `${path} too small to be an executable`);
    const magic = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
    assert.equal(magic >>> 0, GUEST_EXECUTABLE_MAGIC, `${path} missing executable magic`);
  }
});

test('failed libc calls preserve specific kernel errno values', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blk);
  ports.register(PORT.DISK_POS, 1, blk);
  ports.register(PORT.DISK_SECTORS, 1, blk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile('/bad-exec', new TextEncoder().encode('not an executable'));
  fs.writeFile(
    '/bin/errcheck',
    buildUserExecutable(
      'errcheck',
      `
        extern int errno;
        char big[600];
        char *av[2];
        int main(int argc, char **argv) {
          int fd;
          int i;
          fd = open("/nope", 0);
          if (fd != -1) { write(1, "bad-ret\\n", 8); return 1; }
          if (errno != 2) { write(1, "bad-errno\\n", 10); return 2; }
          if (exec("/missing", 0) != -1 || errno != 2) return 3;
          if (exec("/bad-exec", 0) != -1 || errno != 8) return 4;
          i = 0;
          while (i < 600) { big[i] = 'A'; i = i + 1; }
          av[0] = big;
          av[1] = 0;
          if (exec("/bin/echo", av) != -1 || errno != 7) return 5;
          write(1, "ENOENT-ok\\n", 10);
          return 0;
        }
      `,
    ),
  );

  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
  });
  machine.keyboard.feed('errcheck\n');
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  const r = machine.run(20_000_000);
  assert.equal(r.reason, 'halt');
  assert.equal(out.includes('ENOENT-ok\n'), true);
  assert.equal(out.includes('bad-ret\n'), false);
  assert.equal(out.includes('bad-errno\n'), false);
});

test('keyboard read blocks until input arrives, then resumes through IRQ', () => {
  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: buildGuestDiskImage(),
    consoleSink: (s) => (out += s),
  });
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  const idle = machine.run(20_000_000);
  assert.equal(idle.reason, 'halt');
  assert.equal(out.includes('all processes exited'), false);

  machine.keyboard.feed('echo awake\n');
  machine.keyboard.close();
  const done = machine.run(20_000_000);
  assert.equal(done.reason, 'halt');
  assert.equal(out.includes('awake\n'), true);
  assert.equal(out.endsWith('kernel: all processes exited\n'), true);
});
