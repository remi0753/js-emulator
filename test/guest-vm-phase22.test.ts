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

test('Phase 22 demand paging, COW, shared mappings, guard page, and malloc work end to end', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(
    '/bin/vm22',
    buildUserExecutable(
      'vm22',
      `
        extern int errno;
        int main(int argc, char **argv) {
          char *heap;
          char *large;
          char *shared;
          char *shared_again;
          char *readonly;
          char check[4];
          int fd;
          int fd_again;
          int pid;
          int status;

          heap = malloc(6000);
          if (heap == 0) return 1;
          heap[0] = 'H';
          heap[5999] = 33;
          if (heap[0] != 'H' || heap[5999] != 33) return 2;
          free(heap);

          large = mmap(0, 0x280000, 3, 0x22, -1, 0);
          if (large == -1) return 3;
          large[0] = 'A';
          large[0x27ffff] = 'Z';
          pid = fork();
          if (pid == 0) {
            if (large[0] != 'A' || large[0x27ffff] != 'Z') exit(4);
            large[0] = 'C';
            exit(0);
          }
          if (pid < 0 || waitpid(pid, &status, 0) != pid || status != 0) return 5;
          if (large[0] != 'A') return 6;
          if (munmap(large, 0x280000) < 0) return 7;

          fd = open("/tmp/vm22-shared", 0x202);
          if (fd < 0 || write(fd, "abc", 3) != 3) return 8;
          shared = mmap(0, 4096, 3, 1, fd, 0);
          if (shared == -1) return 9;
          fd_again = open("/tmp/vm22-shared", 2);
          if (fd_again < 0) return 18;
          shared_again = mmap(0, 4096, 3, 1, fd_again, 0);
          if (shared_again == -1 || shared_again[0] != 'a') return 19;
          shared[0] = 'P';
          if (shared_again[0] != 'P') return 20;
          pid = fork();
          if (pid == 0) {
            if (shared[0] != 'P') exit(10);
            shared[1] = 'C';
            exit(0);
          }
          if (pid < 0 || waitpid(pid, &status, 0) != pid || status != 0) return 11;
          if (shared[1] != 'C') return 12;
          if (lseek(fd, 0, 0) != 0 || read(fd, check, 3) != 3) return 31;
          if (check[0] != 'P' || check[1] != 'C' || check[2] != 'c') return 32;
          if (lseek(fd, 0, 0) != 0 || write(fd, "Z", 1) != 1) return 33;
          if (shared[0] != 'Z' || shared_again[0] != 'Z') return 34;
          if (munmap(shared, 4096) < 0) return 13;
          if (munmap(shared_again, 4096) < 0) return 21;
          close(fd_again);
          if (lseek(fd, 0, 2) != 3) return 14;
          if (lseek(fd, 0, 0) != 0 || read(fd, check, 3) != 3) return 15;
          close(fd);
          if (check[0] != 'Z' || check[1] != 'C' || check[2] != 'c') return 16;
          fd_again = open("/tmp/vm22-shared", 1);
          if (fd_again < 0) return 29;
          if (mmap(0, 4096, 1, 2, fd_again, 0) != -1 || errno != 13) return 30;
          close(fd_again);

          readonly = mmap(0, 4096, 1, 0x22, -1, 0);
          if (readonly == -1 || readonly[0] != 0) return 22;
          pid = fork();
          if (pid == 0) {
            readonly[0] = 'X';
            exit(23);
          }
          if (pid < 0 || waitpid(pid, &status, 0) != pid ||
              (status & 127) != 11) return 24;

          large = mmap(0, 4096, 3, 0x22, -1, 0);
          if (large == -1) return 25;
          large[0] = 'M';
          pid = fork();
          if (pid == 0) {
            if (mprotect(large, 4096, 1) < 0) exit(26);
            large[0] = 'N';
            exit(27);
          }
          if (pid < 0 || waitpid(pid, &status, 0) != pid ||
              (status & 127) != 11) return 28;

          pid = fork();
          if (pid == 0) {
            char *guard;
            guard = 0x7fe000;
            return guard[0];
          }
          if (pid < 0 || waitpid(pid, &status, 0) != pid ||
              (status & 127) != 11) return 17;

          write(1, "phase22-ok\\n", 11);
          return 0;
        }
      `,
    ),
  );
  fs.chmod('/bin/vm22', 0o755);

  const image = buildGuestKernelImage();
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
  });
  machine.keyboard.feed('vm22\n');
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  assert.equal(machine.run(80_000_000).reason, 'halt');
  assert.equal(output.includes('phase22-ok\n'), true, output);
  assert.equal(output.includes('PANIC'), false, output);
});
