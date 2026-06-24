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
  });
  machine.keyboard.feed(input);
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });
  assert.equal(machine.run(80_000_000).reason, 'halt');
  assert.equal(output.includes('PANIC'), false, output);
  return output;
}

test('Phase 20 mounts devfs, procfs, and tmpfs through the common VFS path', () => {
  const disk = buildGuestDiskImage();
  const statDefinition = `
    struct stat {
      int dev; int ino; int mode; int nlink; int uid; int gid; int rdev;
      int size; int blksize; int blocks; int atime; int mtime; int ctime;
    };
  `;

  addProgram(
    disk,
    'p20',
    `
      ${statDefinition}
      int main(int argc, char **argv) {
        int fd;
        int n;
        char buf[64];
        char linkbuf[8];
        struct stat value;

        fd = open("/dev/null", 1);
        if (fd < 0 || write(fd, "discard", 7) != 7) return 1;
        close(fd);

        fd = open("/dev/zero", 0);
        if (fd < 0 || read(fd, buf, 4) != 4) return 2;
        if (buf[0] != 0 || buf[1] != 0 || buf[2] != 0 || buf[3] != 0) return 3;
        close(fd);

        fd = open("/dev/console", 1);
        if (fd < 0 || write(fd, "vfs-console-ok\\n", 15) != 15) return 4;
        if (fstat(fd, &value) < 0 || (value.mode & 0xf000) != 0x2000) return 5;
        close(fd);

        fd = open("/proc/self", 0);
        if (fd < 0 || fstat(fd, &value) < 0 ||
            (value.mode & 0xf000) != 0x4000) return 6;
        close(fd);
        fd = open("/proc/0/status", 0);
        if (fd < 0) return 7;
        n = read(fd, buf, 63);
        close(fd);
        if (n < 6 || buf[0] != 'P' || buf[5] != '0') return 8;
        n = readlink("/proc/self", linkbuf, 7);
        if (n != 1 || linkbuf[0] != '0' + getpid()) return 9;

        fd = open("/tmp/live", 0x202);
        if (fd < 0 || write(fd, "temp", 4) != 4) return 10;
        if (lseek(fd, 0, 0) != 0 || read(fd, buf, 4) != 4) return 11;
        if (buf[0] != 't' || buf[3] != 'p') return 12;
        if (fstat(fd, &value) < 0 || value.size != 4) return 13;
        close(fd);
        write(1, "phase20-ok\\n", 11);
        return 0;
      }
    `,
  );

  addProgram(
    disk,
    'p20reboot',
    `
      extern int errno;
      int main(int argc, char **argv) {
        if (open("/tmp/live", 0) != -1 || errno != 2) return 1;
        write(1, "phase20-tmp-reset-ok\\n", 21);
        return 0;
      }
    `,
  );

  const first = boot(disk, 'p20\nls /dev\nls /proc\nls /tmp\n');
  assert.equal(first.includes('vfs-console-ok\n'), true, first);
  assert.equal(first.includes('phase20-ok\n'), true, first);
  assert.match(first, /console\nnull\nzero\n/);
  assert.match(first, /self\n0\n/);
  assert.match(first, /live\n/);

  const second = boot(disk, 'p20reboot\n');
  assert.equal(second.includes('phase20-tmp-reset-ok\n'), true, second);
});

test('disk symlinks re-enter VFS mount lookup and loops return ELOOP', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'vfsedge',
    `
      extern int errno;
      int main(int argc, char **argv) {
        int fd;
        char buf[8];
        if (symlink("/proc/self/status", "/absolute") < 0) return 1;
        fd = open("/absolute", 0);
        if (fd < 0 || read(fd, buf, 4) != 4 || buf[0] != 'P') return 2;
        close(fd);

        if (mkdir("/links", 493) < 0) return 3;
        if (symlink("../proc/self/status", "/links/relative") < 0) return 4;
        fd = open("/links/relative", 0);
        if (fd < 0 || read(fd, buf, 4) != 4 || buf[0] != 'P') return 5;
        close(fd);

        if (symlink("/loop-b", "/loop-a") < 0) return 6;
        if (symlink("/loop-a", "/loop-b") < 0) return 7;
        if (open("/loop-a", 0) != -1 || errno != 40) return 8;
        write(1, "vfs-edge-ok\\n", 12);
        return 0;
      }
    `,
  );

  const output = boot(disk, 'vfsedge\n');
  assert.equal(output.includes('vfs-edge-ok\n'), true, output);
});
