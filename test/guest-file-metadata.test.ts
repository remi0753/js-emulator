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

function addProgram(disk: Uint8Array, name: string, source: string): void {
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(`/bin/${name}`, buildUserExecutable(name, source));
  fs.chmod(`/bin/${name}`, 0o755);
}

function boot(disk: Uint8Array, input: string): string {
  const image = buildGuestKernelImage();
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
    rtcTime: 1_700_000_000,
  });
  machine.keyboard.feed(input);
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });
  assert.equal(machine.run(80_000_000).reason, 'halt');
  assert.equal(output.includes('PANIC'), false, output);
  return output;
}

function leaveOneFreeFilesystemBlock(disk: Uint8Array): void {
  const superblock = new DataView(disk.buffer, disk.byteOffset + 512, 512);
  const size = superblock.getUint32(4, true);
  const bitmapStart = superblock.getUint32(16, true);
  let kept = false;
  for (let block = 0; block < size; block++) {
    const byteOffset = bitmapStart * 512 + Math.floor((block % 4096) / 8);
    const mask = 1 << (block % 8);
    if ((disk[byteOffset]! & mask) === 0) {
      if (!kept) {
        kept = true;
      } else {
        disk[byteOffset] = disk[byteOffset]! | mask;
      }
    }
  }
  assert.equal(kept, true);
}

test('Phase 19 metadata, links, directory mutation, and persistence work end to end', () => {
  const disk = buildGuestDiskImage();
  const statDefinition = `
    struct stat {
      int dev; int ino; int mode; int nlink; int uid; int gid; int rdev;
      int size; int blksize; int blocks; int atime; int mtime; int ctime;
    };
  `;

  addProgram(
    disk,
    'p19make',
    `
      ${statDefinition}
      extern int errno;
      int main(int argc, char **argv) {
        int fd;
        int n;
        char buf[8];
        char target[16];
        struct stat value;
        struct stat link_value;

        if (getuid() != 0 || getgid() != 0) return 1;
        if (mkdir("/phase19", 488) < 0) return 2;
        fd = open("/phase19/file", 0x202);
        if (fd < 0) return 3;
        if (write(fd, "alpha", 5) != 5) return 4;
        if (lseek(fd, 0, 0) != 0) return 5;
        if (read(fd, buf, 5) != 5 || buf[0] != 'a' || buf[4] != 'a') return 6;
        if (fstat(fd, &value) < 0 || value.size != 5 ||
            (value.mode & 0xf000) != 0x8000 || value.nlink != 1) return 7;
        close(fd);

        if (chmod("/phase19/file", 416) < 0) return 8;
        if (chown("/phase19/file", 12, 34) < 0) return 9;
        if (stat("/phase19/file", &value) < 0 ||
            (value.mode & 511) != 416 || value.uid != 12 || value.gid != 34 ||
            value.mtime != 1700000000 || value.ctime != 1700000000) return 10;

        if (link("/phase19/file", "/phase19/hard") < 0) return 11;
        if (stat("/phase19/hard", &value) < 0 || value.nlink != 2) return 12;
        if (rename("/phase19/hard", "/phase19/kept") < 0) return 13;
        if (unlink("/phase19/file") < 0) return 14;
        if (stat("/phase19/kept", &value) < 0 || value.nlink != 1) return 15;

        if (symlink("kept", "/phase19/sym") < 0) return 16;
        if (lstat("/phase19/sym", &link_value) < 0 ||
            (link_value.mode & 0xf000) != 0xa000) return 17;
        n = readlink("/phase19/sym", target, 15);
        if (n != 4 || target[0] != 'k' || target[3] != 't') return 18;
        fd = open("/phase19/sym", 0);
        if (fd < 0 || read(fd, buf, 5) != 5 || buf[1] != 'l') return 19;
        close(fd);

        if (mkdir("/phase19/empty", 448) < 0) return 20;
        if (rmdir("/phase19") != -1 || errno != 39) return 21;
        if (rename("/phase19/empty", "/phase19/renamed") < 0) return 22;
        if (rmdir("/phase19/renamed") < 0) return 23;
        write(1, "phase19-make-ok\\n", 16);
        return 0;
      }
    `,
  );

  addProgram(
    disk,
    'p19check',
    `
      ${statDefinition}
      int main(int argc, char **argv) {
        int fd;
        char buf[8];
        struct stat value;
        struct stat link_value;
        if (stat("/phase19/kept", &value) < 0 || value.size != 5 ||
            value.nlink != 1 || value.uid != 12 || value.gid != 34) return 1;
        if (lstat("/phase19/sym", &link_value) < 0 ||
            (link_value.mode & 0xf000) != 0xa000) return 2;
        fd = open("/phase19/sym", 0);
        if (fd < 0 || read(fd, buf, 5) != 5 ||
            buf[0] != 'a' || buf[4] != 'a') return 3;
        close(fd);
        write(1, "phase19-reboot-ok\\n", 18);
        return 0;
      }
    `,
  );

  const first = boot(disk, 'p19make\nls -l /phase19\n');
  assert.equal(first.includes('phase19-make-ok\n'), true, first);
  assert.match(first, /-rw-r----- 1 12 34 5 kept/);
  assert.match(first, /lrwxrwxrwx 1 0 0 4 sym -> kept/);

  const second = boot(disk, 'p19check\n');
  assert.equal(second.includes('phase19-reboot-ok\n'), true, second);
});

test('inode lifetime, rename aliases, live metadata, and exec permissions follow Unix semantics', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'p19edge',
    `
      extern int errno;
      struct stat {
        int dev; int ino; int mode; int nlink; int uid; int gid; int rdev;
        int size; int blksize; int blocks; int atime; int mtime; int ctime;
      };

      int main(int argc, char **argv) {
        int a;
        int b;
        int pid;
        int status;
        char value;
        char *args[2];
        struct stat st;

        a = open("/victim", 0x202);
        if (a < 0 || write(a, "x", 1) != 1) return 1;
        close(a);
        a = open("/victim", 0);
        b = open("/victim", 0);
        if (a < 0 || b < 0 || unlink("/victim") < 0) return 2;
        close(a);
        if (read(b, &value, 1) != 1 || value != 'x') return 3;
        close(b);

        a = open("/live-size", 0x202);
        b = open("/live-size", 0);
        if (a < 0 || b < 0 || write(a, "abc", 3) != 3) return 4;
        if (lseek(b, 0, 2) != 3) return 5;
        close(a);
        close(b);

        a = open("/alias-a", 0x201);
        close(a);
        if (link("/alias-a", "/alias-b") < 0) return 6;
        if (rename("/alias-a", "/alias-b") < 0) return 7;
        if (stat("/alias-a", &st) < 0 || st.nlink != 2) return 8;
        if (stat("/alias-b", &st) < 0 || st.nlink != 2) return 9;

        args[0] = "echo";
        args[1] = 0;
        if (chmod("/bin/echo", 0) < 0) return 10;
        pid = fork();
        if (pid == 0) {
          if (exec("/bin/echo", args) != -1 || errno != 13) exit(11);
          exit(0);
        }
        if (waitpid(pid, &status, 0) != pid || status != 0) return 12;
        if (chmod("/bin/echo", 493) < 0 || chmod("/bin", 0) < 0) return 13;
        pid = fork();
        if (pid == 0) {
          if (exec("/bin/echo", args) != -1 || errno != 13) exit(14);
          exit(0);
        }
        if (waitpid(pid, &status, 0) != pid || status != 0) return 15;
        write(1, "phase19-edge-ok\\n", 16);
        return 0;
      }
    `,
  );

  const output = boot(disk, 'p19edge\n');
  assert.equal(output.includes('phase19-edge-ok\n'), true, output);
});

test('a write that reaches ENOSPC returns and persists its completed prefix', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'partial',
    `
      struct stat {
        int dev; int ino; int mode; int nlink; int uid; int gid; int rdev;
        int size; int blksize; int blocks; int atime; int mtime; int ctime;
      };
      char data[1024];
      int main(int argc, char **argv) {
        int fd;
        int i;
        int wrote;
        char first;
        struct stat st;
        i = 0;
        while (i < 1024) {
          data[i] = 'q';
          i = i + 1;
        }
        fd = open("/partial-data", 0x202);
        if (fd < 0) return 1;
        wrote = write(fd, data, 1024);
        if (wrote != 512) return 2;
        if (fstat(fd, &st) < 0 || st.size != 512) return 3;
        if (lseek(fd, 0, 2) != 512) return 4;
        if (lseek(fd, 0, 0) != 0 || read(fd, &first, 1) != 1 ||
            first != 'q') return 5;
        close(fd);
        write(1, "partial-write-ok\\n", 17);
        return 0;
      }
    `,
  );
  leaveOneFreeFilesystemBlock(disk);

  const output = boot(disk, 'partial\n');
  assert.equal(output.includes('partial-write-ok\n'), true, output);
});
