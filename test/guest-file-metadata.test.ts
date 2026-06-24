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
