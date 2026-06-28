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

function boot(disk: Uint8Array): { machine: Machine; output: () => string } {
  const image = buildGuestKernelImage();
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
  });
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });
  return { machine, output: () => output };
}

test('canonical TTY editing, EOF, and shell redirection work through /dev/tty', () => {
  const { machine, output } = boot(buildGuestDiskImage());
  machine.keyboard.feed(
    'echo mistakX\x7f\n' + 'echo stored > /tmp/tty-out\n' + 'cat < /tmp/tty-out\n' + '\x04',
  );

  assert.equal(machine.run(50_000_000).reason, 'halt');
  assert.equal(output().includes('mistak\n'), true, output());
  assert.equal(output().includes('stored\n'), true, output());
  assert.equal(output().includes('\b \b'), true, output());
  assert.equal(output().endsWith('kernel: all processes exited\n'), true, output());
});

test('termios raw mode and window-size ioctls are guest controlled', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'ttyprobe',
    `
      struct termios {
        int iflag; int oflag; int cflag; int lflag; int line; int cc[12];
      };
      struct winsize { int rows; int cols; int xpixel; int ypixel; };
      int main(int argc, char **argv) {
        struct termios saved;
        struct termios raw;
        struct winsize size;
        char bytes[3];
        if (!isatty(0)) return 1;
        if (tcgetattr(0, &saved) < 0) return 2;
        if ((saved.lflag & 2) == 0 || (saved.lflag & 8) == 0) return 3;
        if (tcgetwinsize(0, &size) < 0 || size.rows != 24 || size.cols != 80) return 4;
        size.rows = 40;
        size.cols = 100;
        if (tcsetwinsize(0, &size) < 0) return 5;
        memset(&raw, 0, sizeof(struct termios));
        raw.cc[6] = 3;
        if (tcsetattr(0, 0, &raw) < 0) return 6;
        if (read(0, bytes, 3) != 3) return 7;
        raw.cc[5] = 1;
        raw.cc[6] = 0;
        if (tcsetattr(0, 0, &raw) < 0) return 10;
        if (read(0, bytes, 1) != 0) return 11;
        if (tcsetattr(0, 0, &saved) < 0) return 8;
        if (bytes[0] != 'x' || bytes[1] != 'y' || bytes[2] != 'z') return 9;
        write(1, "tty-raw-ok\\n", 11);
        return 0;
      }
    `,
  );
  const { machine, output } = boot(disk);
  machine.keyboard.feed('ttyprobe\n');
  assert.equal(machine.run(30_000_000).reason, 'halt');
  assert.equal(output().includes('tty-raw-ok\n'), false);

  machine.keyboard.feed('x');
  assert.equal(machine.run(10_000_000).reason, 'halt');
  assert.equal(output().includes('tty-raw-ok\n'), false);
  machine.keyboard.feed('yz');
  machine.keyboard.close();
  assert.equal(machine.run(30_000_000).reason, 'halt');
  assert.equal(output().includes('tty-raw-ok\n'), true, output());
  assert.equal(output().includes('xyz'), false, output());
});

test('canonical Ctrl-D preserves record boundaries after non-empty input', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'eofprobe',
    `
      #include "libc.h"
      int main(int argc, char **argv) {
        char bytes[8];
        int n;
        n = read(0, bytes, 8);
        if (n != 3) return 1;
        write(1, bytes, n);
        write(1, "|", 1);
        n = read(0, bytes, 8);
        if (n != 3) return 2;
        write(1, bytes, n);
        write(1, "\\n", 1);
        return 0;
      }
    `,
  );
  const { machine, output } = boot(disk);
  machine.keyboard.feed('eofprobe\nabc\x04def\x04\x04');
  assert.equal(machine.run(50_000_000).reason, 'halt');
  assert.equal(output().includes('abc|def\n'), true, output());
  assert.equal(output().endsWith('kernel: all processes exited\n'), true, output());
});

test('Ctrl-Z stops the foreground job and returns terminal control to the shell', () => {
  const { machine, output } = boot(buildGuestDiskImage());
  machine.keyboard.feed('spin\n');
  assert.notEqual(machine.run(80_000_000).reason, 'halt');

  machine.keyboard.feed('\x1a');
  assert.equal(machine.run(40_000_000).reason, 'halt');
  assert.equal(output().includes('^Z\n'), true, output());

  machine.keyboard.feed('echo resumed-shell\nshutdown\n');
  assert.equal(machine.run(30_000_000).reason, 'halt');
  assert.equal(output().includes('resumed-shell\n'), true, output());
  assert.equal(machine.power.poweredOff, true);
});
