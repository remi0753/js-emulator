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

test('Phase 27 kernel log, syscall tracing, and /proc inspection', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'p27',
    `
      #include "libc.h"
      char buf[2048];

      int contains(int n, char *needle) {
        int i;
        int j;
        i = 0;
        while (i < n) {
          j = 0;
          while (needle[j] != 0 && i + j < n && buf[i + j] == needle[j]) j = j + 1;
          if (needle[j] == 0) return 1;
          i = i + 1;
        }
        return 0;
      }

      int slurp(char *path) {
        int fd;
        int n;
        fd = open(path, 0);
        if (fd < 0) return -1;
        n = read(fd, buf, 2048);
        close(fd);
        return n;
      }

      void set_trace(char *value) {
        int fd;
        fd = open("/sys/trace", 1);
        if (fd < 0) return;
        write(fd, value, 1);
        close(fd);
      }

      int main(int argc, char **argv) {
        int n;
        char *heap;

        // The kernel log captured the boot/exec banner, readable via /dev/kmsg.
        n = slurp("/dev/kmsg");
        if (n > 0 && contains(n, "kernel: boot") != 0 &&
            contains(n, "exec /bin/init") != 0) printf("log-ok\\n");

        // Enriched /proc/<pid>/status carries Linux-shaped fields.
        n = slurp("/proc/self/status");
        if (n > 0 && contains(n, "State:") != 0 &&
            contains(n, "PPid:") != 0 && contains(n, "Uid:") != 0)
          printf("status-ok\\n");

        // Touch the heap so /proc/self/maps reports a region to dump.
        heap = malloc(64);
        heap[0] = 7;
        n = slurp("/proc/self/maps");
        if (n > 0 && contains(n, "[heap]") != 0) printf("maps-ok\\n");

        // Toggle syscall tracing through /sys/trace; the dispatcher logs each
        // syscall into the kernel log.
        set_trace("1");
        getpid();
        set_trace("0");
        n = slurp("/dev/kmsg");
        if (n > 0 && contains(n, "trace: pid=") != 0 &&
            contains(n, "getpid") != 0) printf("trace-ok\\n");
        return 0;
      }
    `,
  );

  const out = boot(disk, 'p27\nshutdown\n');
  assert.equal(out.includes('log-ok\n'), true, out);
  assert.equal(out.includes('status-ok\n'), true, out);
  assert.equal(out.includes('maps-ok\n'), true, out);
  assert.equal(out.includes('trace-ok\n'), true, out);
  // The trace lines are mirrored to the serial console as well.
  assert.match(out, /trace: pid=\d+ getpid\(/);
});

test('Phase 27 userland tools: dmesg prints the kernel log and ps lists procs', () => {
  const disk = buildGuestDiskImage();
  const out = boot(disk, 'dmesg\nps\nshutdown\n');
  // dmesg prints the captured kernel boot log.
  assert.equal(out.includes('kernel: boot\n'), true, out);
  // ps prints a header and at least one running/sleeping process row.
  assert.equal(out.includes('  PID S\n'), true, out);
  assert.match(out, /\n {4}\d+ [RSTZ?]\n/);
});

test('Phase 27 kmsg retains the newest log entries after wrapping', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'p27wrap',
    `
      #include "libc.h"
      char buf[4096];

      int contains(int n, char *needle) {
        int i;
        int j;
        i = 0;
        while (i < n) {
          j = 0;
          while (needle[j] != 0 && i + j < n && buf[i + j] == needle[j]) j = j + 1;
          if (needle[j] == 0) return 1;
          i = i + 1;
        }
        return 0;
      }

      void set_trace(char *value) {
        int fd;
        fd = open("/sys/trace", 1);
        if (fd >= 0) {
          write(fd, value, 1);
          close(fd);
        }
      }

      int main(int argc, char **argv) {
        int fd;
        int i;
        int n;
        set_trace("1");
        i = 0;
        while (i < 260) {
          getpid();
          i = i + 1;
        }
        lseek(123, 777, 0);
        set_trace("0");
        fd = open("/dev/kmsg", 0);
        if (fd < 0) return 1;
        n = read(fd, buf, 4096);
        close(fd);
        if (n > 0 && contains(n, "lseek(123, 777, 0)") != 0) {
          printf("wrap-ok\\n");
          return 0;
        }
        printf("wrap-missing\\n");
        return 2;
      }
    `,
  );
  const out = boot(disk, 'p27wrap\nshutdown\n');
  assert.equal(out.includes('wrap-ok\n'), true, out);
});

test('Phase 27 /sys/trace reports the current trace bitmask and disk tracing works', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'p27b',
    `
      #include "libc.h"
      char buf[1024];
      int main(int argc, char **argv) {
        int fd;
        int n;
        // Default trace bitmask is 0.
        fd = open("/sys/trace", 0);
        n = read(fd, buf, 16);
        close(fd);
        if (n >= 1 && buf[0] == '0') printf("trace-default-0\\n");

        // Enable disk tracing (bit 1 -> value 2) and force a filesystem read.
        fd = open("/sys/trace", 1);
        write(fd, "2", 1);
        close(fd);
        fd = open("/etc/motd", 0);
        n = read(fd, buf, 16);
        close(fd);

        // Read back the bitmask through /sys/trace.
        fd = open("/sys/trace", 0);
        n = read(fd, buf, 16);
        close(fd);
        if (n >= 1 && buf[0] == '2') printf("trace-set-2\\n");
        return 0;
      }
    `,
  );
  const out = boot(disk, 'p27b\nshutdown\n');
  assert.equal(out.includes('trace-default-0\n'), true, out);
  assert.equal(out.includes('trace-set-2\n'), true, out);
  // The block driver logged a disk read while disk tracing was enabled.
  assert.match(out, /trace: disk read blk=\d+/);
});
