import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
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
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile('/ops-data', new TextEncoder().encode('vnode-data\n'));
  fs.writeFile('/offset-data', new TextEncoder().encode('AB'));
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
          int pid;
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

          // dup() aliases one open-file description, including its offset.
          fd = open("/offset-data", 0);
          if (fd < 0) return 8;
          copy = dup(fd);
          if (copy < 0) return 9;
          if (read(fd, buf, 1) != 1) return 10;
          if (read(copy, buf + 1, 1) != 1) return 11;
          if (buf[0] != 'A' || buf[1] != 'B') return 12;
          close(fd);
          close(copy);

          // fork() inherits the same open-file description. The child's read
          // advances the offset observed by the parent after wait().
          fd = open("/offset-data", 0);
          if (fd < 0) return 13;
          pid = fork();
          if (pid == 0) {
            if (read(fd, buf, 1) != 1) exit(14);
            exit(0);
          }
          if (pid < 0) return 15;
          wait();
          if (read(fd, buf, 1) != 1) return 16;
          if (buf[0] != 'B') return 17;
          close(fd);
          return 0;
        }
      `,
    ),
  );
  fs.chmod('/bin/fileops', 0o755);

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

  // Budget includes the 64 MiB identity-map build during boot.
  assert.equal(machine.run(45_000_000).reason, 'halt');
  assert.equal(output.includes('vnode-data\n'), true);
  assert.equal(output.endsWith('kernel: all processes exited\n'), true);
});
