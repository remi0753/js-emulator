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

test('read faults in heap pages across a 4 MiB page-directory boundary', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);

  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();

  const payload = new Uint8Array(4096);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + 3) & 0xff;
  fs.writeFile('/payload', payload);

  fs.writeFile(
    '/bin/repro',
    buildUserExecutable(
      'repro',
      `
        #define O_RDONLY 0

        int main(int argc, char **argv) {
          int fd;
          int got;
          int i;
          int boundary;
          char *cur;
          char *buf;

          cur = sbrk(0);
          boundary = (((int)cur + 0x3fffff) / 0x400000) * 0x400000;
          if (boundary - 64 < (int)cur) boundary = boundary + 0x400000;
          buf = (char *)(boundary - 64);
          if (sbrk((buf + 4096) - cur) == (void *)-1) {
            printf("SBRKFAIL\\n");
            return 1;
          }

          fd = open("/payload", O_RDONLY);
          if (fd < 0) {
            printf("OPENFAIL\\n");
            return 1;
          }
          got = read(fd, buf, 4096);
          if (got != 4096) {
            printf("READFAIL got=%d boundary=%d buf=%d\\n", got, boundary, (int)buf);
            return 1;
          }
          close(fd);

          i = 0;
          while (i < 4096) {
            if ((buf[i] & 255) != ((i * 17 + 3) & 255)) {
              printf("BAD i=%d got=%d\\n", i, buf[i] & 255);
              return 1;
            }
            i = i + 1;
          }
          printf("OK boundary-read\\n");
          return 0;
        }
      `,
    ),
  );
  fs.chmod('/bin/repro', 0o755);

  const image = buildGuestKernelImage();
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
  });
  machine.keyboard.feed('repro\n');
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  const result = machine.run(120_000_000);
  assert.equal(result.reason, 'halt', output);
  assert.ok(output.includes('OK boundary-read\n'), output);
});
