import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeBootBlock, makeBootBlock } from '../src/formats/bootblock.ts';
import { BLOCK_SIZE } from '../src/storage/block.ts';
import { bootGuestDiskImage, readGuestBootBlock } from '../src/v3/boot.ts';
import {
  buildGuestDiskImage,
  buildGuestKernelImage,
  GUEST_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';

test('the maintained disk image contains the guest kernel and boots without host injection', () => {
  const kernel = buildGuestKernelImage();
  const disk = buildGuestDiskImage({ kernel });
  const manifest = readGuestBootBlock(disk);
  const kernelOffset = manifest.kernelStart * BLOCK_SIZE;

  assert.equal(manifest.kernelBytes, kernel.flat.length);
  assert.equal(manifest.kernelEntry, kernel.entry);
  assert.equal(manifest.kernelStack, GUEST_KERNEL_LAYOUT.kstackTop);
  assert.deepEqual(disk.subarray(kernelOffset, kernelOffset + manifest.kernelBytes), kernel.flat);

  let output = '';
  const { machine } = bootGuestDiskImage(disk, {
    consoleSink: (text) => (output += text),
  });
  machine.keyboard.feed('echo disk-kernel-ok\nshutdown\n');

  assert.equal(machine.run(30_000_000).reason, 'halt');
  assert.equal(output.includes('disk-kernel-ok\n'), true, output);
  assert.equal(machine.power.poweredOff, true);
});

test('guest boot rejects disks without a valid installed kernel region', () => {
  const disk = buildGuestDiskImage();

  const missing = disk.slice();
  missing.set(encodeBootBlock(makeBootBlock('/bin/init')), 0);
  assert.throws(() => bootGuestDiskImage(missing), /no installed guest kernel/);

  const pastEnd = disk.slice();
  const manifest = readGuestBootBlock(disk);
  pastEnd.set(
    encodeBootBlock(
      makeBootBlock('/bin/init', {
        ...manifest,
        kernelStart: disk.length / BLOCK_SIZE,
      }),
    ),
    0,
  );
  assert.throws(() => bootGuestDiskImage(pastEnd), /extends past the disk image/);
});
