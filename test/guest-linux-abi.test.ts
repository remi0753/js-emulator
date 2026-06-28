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

const RTC_TIME = 1_700_000_000;

test('Phase 18 Linux-shaped libc ABI works end to end', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(
    '/bin/abi18',
    buildUserExecutable(
      'abi18',
      `
        extern int errno;

        struct timespec { int tv_sec; int tv_nsec; };
        struct timeval { int tv_sec; int tv_usec; };
        struct utsname {
          char sysname[32];
          char nodename[32];
          char release[32];
          char version[32];
          char machine[32];
          char domainname[32];
        };
        struct dirent {
          int ino;
          int offset;
          int reclen;
          int type;
          char name[16];
        };

        int getppid(void);
        int nanosleep(struct timespec *request, struct timespec *remaining);
        void *sbrk(int increment);
        void *mmap(void *address, int length, int protection, int flags,
          int fd, int offset);
        int munmap(void *address, int length);
        int mprotect(void *address, int length, int protection);
        int fcntl(int fd, int command, int argument);
        int ioctl(int fd, int request, int argument);
        int gettimeofday(struct timeval *value, void *timezone);
        int clock_gettime(int clock_id, struct timespec *value);
        int uname(struct utsname *name);
        int getdents(int fd, struct dirent *entries, int count);

        struct dirent entries[8];

        int main(int argc, char **argv) {
          int parent;
          int pid;
          int status;
          int fd;
          int copy;
          int flags;
          int pgid;
          int n;
          int i;
          int found;
          char *heap;
          char *mapping;
          char *file_mapping;
          struct timespec before;
          struct timespec after;
          struct timespec request;
          struct timeval wall;
          struct utsname system;

          parent = getpid();
          pid = fork();
          if (pid == 0) {
            if (getppid() != parent) exit(1);
            exit(0);
          }
          if (pid < 0 || waitpid(pid, &status, 0) != pid || status != 0) return 2;

          heap = sbrk(4096);
          if (heap == -1) return 3;
          heap[0] = 'H';
          heap[4095] = 33;
          if (heap[0] != 'H' || heap[4095] != 33) return 4;
          if (sbrk(-4096) == -1) return 5;

          mapping = mmap(0, 8192, 3, 0x22, -1, 0);
          if (mapping == -1) return 6;
          mapping[0] = 'M';
          mapping[4096] = 'N';
          pid = fork();
          if (pid == 0) {
            if (mapping[0] != 'M' || mapping[4096] != 'N') exit(33);
            mapping[0] = 'C';
            exit(0);
          }
          if (pid < 0 || waitpid(pid, &status, 0) != pid || status != 0) return 34;
          if (mapping[0] != 'M') return 35;
          if (mprotect(mapping, 8192, 1) < 0) return 7;
          if (write(1, mapping, 1) != 1) return 8;
          if (mprotect(mapping, 8192, 0) < 0) return 9;
          if (write(1, mapping, 1) != -1 || errno != 14) return 10;
          if (mprotect(mapping, 8192, 3) < 0) return 11;
          if (munmap(mapping, 8192) < 0) return 12;
          if (write(1, mapping, 1) != -1 || errno != 14) return 13;

          fd = open("/etc/motd", 0);
          if (fd < 0) return 14;
          file_mapping = mmap(0, 4096, 1, 2, fd, 0);
          if (file_mapping == -1 || file_mapping[0] != 'w') return 15;
          if (munmap(file_mapping, 4096) < 0) return 16;
          close(fd);

          fd = open("/", 0);
          if (fd < 0) return 17;
          n = getdents(fd, entries, sizeof(struct dirent) * 8);
          if (n <= 0) return 18;
          found = 0;
          i = 0;
          while (i < n / sizeof(struct dirent)) {
            if (strcmp(entries[i].name, "etc") == 0) found = 1;
            i = i + 1;
          }
          close(fd);
          if (found == 0) return 19;

          fd = open("/etc/motd", 0);
          copy = fcntl(fd, 0, 5);
          if (copy < 5) return 20;
          if (fcntl(copy, 2, 1) < 0 || fcntl(copy, 1, 0) != 1) return 21;
          flags = fcntl(fd, 3, 0);
          if (flags != 0) return 22;
          close(copy);
          close(fd);

          pgid = 0;
          if (ioctl(0, 0x540f, &pgid) < 0) return 23;
          if (pgid != tcgetpgrp()) return 24;

          if (gettimeofday(&wall, 0) < 0 || wall.tv_sec != ${RTC_TIME}) return 25;
          if (clock_gettime(1, &before) < 0) return 26;
          request.tv_sec = 0;
          request.tv_nsec = 20000000;
          if (nanosleep(&request, 0) < 0) return 27;
          if (clock_gettime(1, &after) < 0) return 28;
          if (after.tv_sec < before.tv_sec ||
              (after.tv_sec == before.tv_sec && after.tv_nsec <= before.tv_nsec)) {
            return 29;
          }

          if (uname(&system) < 0) return 30;
          if (strcmp(system.sysname, "jscpu-os") != 0) return 31;
          if (strcmp(system.machine, "custom32") != 0) return 32;
          write(1, "phase18-ok\\n", 11);
          return 0;
        }
      `,
    ),
  );
  fs.chmod('/bin/abi18', 0o755);

  const image = buildGuestKernelImage();
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
    rtcTime: RTC_TIME,
  });
  machine.keyboard.feed('abi18\n');
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  assert.equal(machine.run(60_000_000).reason, 'halt');
  assert.equal(output.includes('phase18-ok\n'), true, output);
  assert.equal(output.includes('PANIC'), false, output);
  assert.equal(output.endsWith('kernel: all processes exited\n'), true, output);
});

test('munmap leaves non-VMA image pages intact and user page faults become SIGSEGV', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(
    '/bin/vmedge',
    buildUserExecutable(
      'vmedge',
      `
        int main(int argc, char **argv) {
          int pid;
          int status;
          char *mapping;
          if (munmap(0x4000000, 4096) < 0) return 1;
          mapping = mmap(0, 4096, 0, 0x22, -1, 0);
          if (mapping == -1) return 2;
          pid = fork();
          if (pid == 0) {
            return mapping[0];
          }
          if (waitpid(pid, &status, 0) != pid || (status & 127) != 11) return 3;
          write(1, "vm-edge-ok\\n", 11);
          return 0;
        }
      `,
    ),
  );
  fs.chmod('/bin/vmedge', 0o755);

  const image = buildGuestKernelImage();
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
  });
  machine.keyboard.feed('vmedge\n');
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  assert.equal(machine.run(50_000_000).reason, 'halt');
  assert.equal(output.includes('vm-edge-ok\n'), true, output);
  assert.equal(output.includes('PANIC'), false, output);
});
