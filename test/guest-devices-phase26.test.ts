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
import { Entropy } from '../src/vm/custom32/devices/entropy.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

const RTC_TIME = 1_700_000_000;

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
    rtcTime: RTC_TIME,
  });
  machine.keyboard.feed(input);
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });
  assert.equal(machine.run(80_000_000).reason, 'halt');
  assert.equal(output.includes('PANIC'), false, output);
  return output;
}

const statDefinition = `
  struct stat {
    int dev; int ino; int mode; int nlink; int uid; int gid; int rdev;
    int size; int blksize; int blocks; int atime; int mtime; int ctime;
  };
`;

test('Phase 26 char devices dispatch through the driver registry', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'p26',
    `
      ${statDefinition}
      int main(int argc, char **argv) {
        int fd;
        int i;
        int v;
        char buf[8];
        struct stat st;

        // /dev/rtc reads the RTC driver as a 4-byte little-endian timestamp.
        fd = open("/dev/rtc", 0);
        if (fd < 0) { printf("rtc-open-fail\\n"); return 1; }
        if (read(fd, buf, 4) != 4) { printf("rtc-read-fail\\n"); return 2; }
        close(fd);
        v = (buf[0] & 0xff) | ((buf[1] & 0xff) << 8) |
            ((buf[2] & 0xff) << 16) | ((buf[3] & 0xff) << 24);
        printf("rtc=");
        print_int(v);
        printf("\\n");

        // /dev/urandom reads the entropy driver byte stream.
        fd = open("/dev/urandom", 0);
        if (fd < 0) { printf("rnd-open-fail\\n"); return 3; }
        if (read(fd, buf, 4) != 4) { printf("rnd-read-fail\\n"); return 4; }
        close(fd);
        printf("rnd=");
        i = 0;
        while (i < 4) {
          print_int(buf[i] & 0xff);
          printf(" ");
          i = i + 1;
        }
        printf("\\n");

        // A char device node reports S_IFCHR and a major:minor rdev.
        fd = open("/dev/random", 0);
        if (fd < 0 || fstat(fd, &st) < 0) { printf("stat-fail\\n"); return 5; }
        close(fd);
        if ((st.mode & 0xf000) == 0x2000 && st.rdev == (6 << 8)) {
          printf("dev-ok\\n");
        }
        return 0;
      }
    `,
  );

  const entropy = new Entropy();
  const expectedRnd = `rnd=${entropy.read(0)} ${entropy.read(0)} ${entropy.read(0)} ${entropy.read(0)} \n`;

  const out = boot(disk, 'p26\nls /dev\ncat /sys/devices\ncat /sys/irq\nls /sys\nshutdown\n');

  // The RTC driver returned the configured wall-clock time.
  assert.equal(out.includes(`rtc=${RTC_TIME}\n`), true, out);
  // The entropy driver produced the deterministic seeded byte stream.
  assert.equal(out.includes(expectedRnd), true, out);
  // The /dev node carried char-device metadata (mode + major:minor rdev).
  assert.equal(out.includes('dev-ok\n'), true, out);

  // devfs lists every registered driver, including the new Phase 26 nodes.
  assert.match(out, /console\nnull\nzero\ntty\nrtc\nrandom\nurandom\n/);

  // /sys exposes the device registry and IRQ ownership for inspection.
  assert.match(out, /5 rtc\n6 random\n7 urandom\n/);
  assert.equal(out.includes('1 console\n'), true, out);
  assert.equal(out.includes('keyboard\n'), true, out);
  assert.equal(out.includes('net\n'), true, out);
  assert.match(out, /devices\nirq\n/);
});

test('the keyboard IRQ is still routed through the driver model', () => {
  // Input is delivered by the keyboard device IRQ, which now funnels through
  // irq_dispatch() to the registered keyboard_isr. If routing broke, the shell
  // would never see these commands.
  const disk = buildGuestDiskImage();
  const out = boot(disk, 'echo via-irq\nshutdown\n');
  assert.equal(out.includes('via-irq\n'), true, out);
});
