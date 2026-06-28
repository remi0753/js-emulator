import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import { buildUserExecutable } from '../src/v3/guest-kernel.ts';
import {
  buildGuestDiskImage,
  buildGuestKernelImage,
  GUEST_DEVELOPMENT_FS_BLOCKS,
  GUEST_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

const PHASE33_SRC = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <stdint.h>
#include <limits.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

int main(void) {
  char formatted[64];
  char *end;
  char *heap;
  FILE *tmp;
  char path[32];
  char ch;
  int i;
  int fd;
  struct stat st;

  if (sizeof(uint32_t) != 4 || INT_MAX != 2147483647) return 1;
  if (snprintf(formatted, 64, "fmt:%s:%d:%x:%c:%%", "ok", -7, 255, 'Z') != 16) return 2;
  if (strcmp(formatted, "fmt:ok:-7:ff:Z:%") != 0) return 3;
  if (strtol("  -0x10z", &end, 0) != -16 || *end != 'z') return 4;
  if (!isalpha('Q') || !isdigit('7') || !isspace('\\n') ||
      toupper('q') != 'Q' || tolower('Q') != 'q') return 5;

  heap = malloc(131072);
  if (heap == 0) return 6;
  i = 0;
  while (i < 131072) {
    heap[i] = i & 255;
    i = i + 4096;
  }
  if (heap[65536] != 0) return 7;

  tmp = tmpfile();
  if (tmp == 0) return 8;
  i = 0;
  while (i < 2048) {
    heap[i] = 'A' + (i % 26);
    i = i + 1;
  }
  if (fwrite(heap, 1, 2048, tmp) != 2048) return 9;
  if (ftell(tmp) != 2048) return 10;
  if (fseek(tmp, 1024, SEEK_SET) < 0) return 11;
  ch = fgetc(tmp);
  if (ch != 'A' + (1024 % 26)) return 12;
  fclose(tmp);
  free(heap);

  strcpy(path, "/tmp/phase33-template");
  fd = mkstemp(path);
  if (fd < 0) return 13;
  if (write(fd, "OBJ", 3) != 3) return 14;
  if (lseek(fd, 0, SEEK_SET) != 0) return 15;
  if (read(fd, formatted, 3) != 3) return 16;
  formatted[3] = 0;
  close(fd);
  if (strcmp(formatted, "OBJ") != 0) return 17;
  if (stat(path, &st) < 0 || st.size != 3) return 18;
  if (remove(path) < 0) return 19;
  if (stat(path, &st) != -1 || errno != ENOENT) return 20;

  printf("phase33 %s %d %x\\n", "ok", 123, 48879);
  return 0;
}
`;

function installFs(image: Uint8Array): Fs {
  const ports = new PortBus();
  const blk = new BlockDisk(image);
  ports.register(PORT.DISK_DATA, 1, blk);
  ports.register(PORT.DISK_POS, 1, blk);
  ports.register(PORT.DISK_SECTORS, 1, blk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  return fs;
}

function bootAndRun(disk: Uint8Array, command: string): string {
  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
  });
  machine.keyboard.feed(`${command}\n`);
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });
  const result = machine.run(120_000_000);
  assert.equal(result.reason, 'halt', out);
  return out;
}

test('Phase 33 libc headers, variadic stdio, heap, and temp files run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/phase33', buildUserExecutable('phase33', PHASE33_SRC));
  fs.chmod('/bin/phase33', 0o755);

  const out = bootAndRun(disk, 'phase33');
  assert.equal(out.includes('phase33 ok 123 beef\n'), true, out);
  assert.equal(out.includes('PANIC'), false, out);
});

test('Phase 33 development disk images reserve larger filesystem space', () => {
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  assert.ok(disk.length > 16 * 1024 * 1024);
});
