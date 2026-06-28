import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import { installChibiccToolchain } from '../src/v3/guest-chibicc.ts';
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

function readText(fs: Fs, path: string): string {
  const inum = fs.namei(path);
  assert.notEqual(inum, 0, `${path} should exist`);
  return new TextDecoder().decode(fs.readFile(inum));
}

function bootAndRun(disk: Uint8Array, command: string, budget = 900_000_000): string {
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
  const result = machine.run(budget);
  assert.equal(result.reason, 'halt', `VM stopped with ${result.reason}; output:\n${out}`);
  return out;
}

test('chibicc Phase 35 installs compiler sources and replays a guest rebuild deterministically', () => {
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  let fs = installFs(disk);
  installChibiccToolchain(fs, { installSources: true });

  assert.match(readText(fs, '/usr/src/cc/README'), /bootstrap source bundle/);
  assert.match(readText(fs, '/usr/src/cc/main.c'), /compile_to_asm_memory/);
  assert.match(readText(fs, '/usr/src/cc/selfhost.c'), /cc_selfhost_probe/);
  assert.match(readText(fs, '/usr/src/cc/upstream/chibicc.h'), /typedef struct Type Type/);

  const out = bootAndRun(
    disk,
    [
      'cc -S -o /s1probe.s /usr/src/cc/selfhost.c',
      'cc -S -o /s2probe.s /usr/src/cc/selfhost.c',
      'echo phase35 replayed',
    ].join('\n'),
    900_000_000,
  );

  assert.ok(out.includes('phase35 replayed\n'), `missing completion marker in:\n${out}`);
  assert.equal(out.includes('cc:'), false, out);
  assert.equal(out.includes('PANIC'), false, out);

  fs = installFs(disk);
  const stage1Support = readText(fs, '/s1probe.s');
  const stage2Support = readText(fs, '/s2probe.s');

  assert.ok(stage1Support.includes('cc_selfhost_probe:\n'), stage1Support.slice(0, 200));
  assert.ok(stage1Support.includes('CALL cc_selfhost_align\n'), stage1Support.slice(0, 200));
  assert.equal(stage1Support, stage2Support);
});
