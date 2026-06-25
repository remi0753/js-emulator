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

test('Phase 24 poll and nonblocking descriptors work without busy waiting', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(
    '/bin/io24',
    buildUserExecutable(
      'io24',
      `
        #include "libc.h"
        int main(int argc, char **argv) {
          int fds[2];
          struct pollfd watched[1];
          char byte;
          int flags;
          int result;
          if (pipe(fds) < 0) return 1;
          flags = fcntl(fds[0], 3, 0);
          if (flags < 0 || fcntl(fds[0], 4, flags | 0x800) < 0) return 2;
          if (read(fds[0], &byte, 1) != -1 || errno != 11) return 3;
          if (write(fds[1], "P", 1) != 1) return 4;
          watched[0].fd = fds[0];
          watched[0].events = 1;
          watched[0].revents = 0;
          if (poll(watched, 1, 0) != 1) return 5;
          if ((watched[0].revents & 1) == 0) return 6;
          if (read(fds[0], &byte, 1) != 1 || byte != 'P') return 7;
          watched[0].revents = 0;
          result = poll(watched, 1, 20);
          if (result != 0) return 8;
          close(fds[0]);
          flags = fcntl(fds[1], 3, 0);
          if (fcntl(fds[1], 4, flags | 0x800) < 0) return 9;
          if (write(fds[1], "X", 1) != -1 || errno != 32) return 10;
          write(1, "phase24-ok\\n", 11);
          return 0;
        }
      `,
    ),
  );
  fs.chmod('/bin/io24', 0o755);

  const kernel = buildGuestKernelImage();
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
  });
  machine.keyboard.feed('io24\n');
  machine.keyboard.close();
  machine.load(0, kernel.flat);
  machine.reset({ pc: kernel.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  assert.equal(machine.run(100_000_000).reason, 'halt');
  assert.equal(output.includes('phase24-ok\n'), true, output);
  assert.equal(output.includes('PANIC'), false, output);
});
