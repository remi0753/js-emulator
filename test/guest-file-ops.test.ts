import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BlockDriver } from '../src/v2/kernel/disk.ts';
import { Fs } from '../src/v2/kernel/fs.ts';
import {
  buildGuestDiskImage,
  buildGuestKernelImage,
  buildUserExecutable,
  GUEST_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

test('structured file objects dispatch vnode, pipe, terminal, and console operations', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new BlockDriver(ports));
  fs.mount();
  fs.writeFile('/ops-data', new TextEncoder().encode('vnode-data\n'));
  fs.writeFile(
    '/bin/fileops',
    buildUserExecutable(
      'fileops',
      `
        char buf[32];
        int main(int argc, char **argv) {
          int fd;
          int p[2];
          int copy;
          int n;
          fd = open("/ops-data", 0);
          if (fd < 0) return 1;
          n = read(fd, buf, 32);
          close(fd);
          if (n != 11) return 2;
          if (pipe(p) < 0) return 3;
          copy = dup(p[1]);
          if (copy < 0) return 4;
          close(p[1]);
          if (write(copy, buf, n) != n) return 5;
          close(copy);
          n = read(p[0], buf, 32);
          if (n != 11) return 6;
          close(p[0]);
          if (write(1, buf, n) != n) return 7;
          return 0;
        }
      `,
    ),
  );

  const image = buildGuestKernelImage();
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
  });
  machine.keyboard.feed('fileops\n');
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  assert.equal(machine.run(30_000_000).reason, 'halt');
  assert.equal(output.includes('vnode-data\n'), true);
  assert.equal(output.endsWith('kernel: all processes exited\n'), true);
});
