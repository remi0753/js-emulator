import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import {
  buildGuestDiskImage,
  buildGuestKernelImage,
  buildUserExecutable,
  GUEST_KERNEL_LAYOUT,
  GUEST_USER_PROGRAMS,
} from '../src/v3/guest-kernel.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

test('Phase 23 libc, environment, scripts, text tools, and multi-stage pipelines work', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(
    '/bin/forklimit',
    buildUserExecutable(
      'forklimit',
      `
        #include "libc.h"
        int children[20];
        int main(int argc, char **argv) {
          int count;
          int pid;
          int i;
          int status;
          count = 0;
          while (count < 20) {
            pid = fork();
            if (pid == 0) {
              while (1) {
              }
            }
            if (pid < 0) break;
            children[count] = pid;
            count = count + 1;
          }
          if (count == 20 || (errno != 11 && errno != 12)) return 1;
          i = 0;
          while (i < count) {
            kill(children[i], 9);
            i = i + 1;
          }
          i = 0;
          while (i < count) {
            waitpid(children[i], &status, 0);
            i = i + 1;
          }
          write(1, "forklimit-ok\\n", 13);
          return 0;
        }
      `,
    ),
  );
  fs.chmod('/bin/forklimit', 0o755);
  const kernel = buildGuestKernelImage();
  const script =
    'export GREETING=hello\n' +
    'export PATH=/missing:/bin\n' +
    'echo path-search\n' +
    'echo bad | | wc\n' +
    'echo after-bad-pipeline\n' +
    'echo x | cat | cat | cat | wc\n' +
    'echo after-long-pipeline\n' +
    'forklimit\n' +
    'env | grep GREETING\n' +
    'ls /tmp | grep booted\n' +
    'selftest\n' +
    'wc /etc/motd\n' +
    'head /etc/motd\n';
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
  });
  machine.keyboard.feed(script);
  machine.keyboard.close();
  machine.load(0, kernel.flat);
  machine.reset({ pc: kernel.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  assert.equal(machine.run(80_000_000).reason, 'halt');
  assert.equal(output.includes('GREETING=hello\n'), true, output);
  assert.equal(output.includes('path-search\n'), true, output);
  assert.equal(output.includes('sh: bad pipeline\n'), true, output);
  assert.equal(output.includes('after-bad-pipeline\n'), true, output);
  assert.equal(output.includes('sh: pipeline too long\n'), true, output);
  assert.equal(output.includes('after-long-pipeline\n'), true, output);
  assert.equal(output.includes('forklimit-ok\n'), true, output);
  assert.equal(output.includes('booted\n'), true, output);
  assert.equal(output.includes('libc-tests: ok\n'), true, output);
  assert.equal(output.includes('script-pipeline\n'), true, output);
  assert.equal(output.includes('1 3 20\n'), true, output);
  assert.equal(output.includes('welcome to jscpu-os\n'), true, output);
  assert.equal(output.includes('PANIC'), false, output);
});

test('Phase 23 image manifest installs libc-based tools and init scripts', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();

  for (const name of GUEST_USER_PROGRAMS) {
    assert.ok(fs.namei(`/bin/${name}`) > 0, `missing /bin/${name}`);
  }
  for (const path of ['/bin/selftest', '/etc/rc', '/etc/profile', '/etc/packages']) {
    assert.ok(fs.namei(path) > 0, `missing ${path}`);
  }
});
