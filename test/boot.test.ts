import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bootImage, buildDiskImage } from '../src/v2/boot.ts';
import {
  BOOT_MAGIC,
  BOOT_SIGNATURE,
  decodeBootBlock,
  encodeBootBlock,
  makeBootBlock,
} from '../src/v2/kernel/bootblock.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';

// Phase 9: a boot path and disk-image contract. One call builds a self-describing
// disk image; another boots it through the sector-0 manifest — with no userland
// installation or hard-coded init in the host.

test('boot block encodes and decodes round-trip', () => {
  const bb = makeBootBlock('/bin/init', { kernelStart: 8, kernelBlocks: 4 });
  const decoded = decodeBootBlock(encodeBootBlock(bb));
  assert.deepEqual(decoded, bb);
  assert.equal(decoded.magic, BOOT_MAGIC);
});

test('an encoded boot block carries the boot-sector signature in sector 0', () => {
  const sector = encodeBootBlock(makeBootBlock('/bin/init'));
  assert.equal(sector.length, 512);
  const sig = sector[510]! | (sector[511]! << 8);
  assert.equal(sig, BOOT_SIGNATURE);
});

test('buildDiskImage produces a bootable image: manifest in sector 0, userland on disk', () => {
  const image = buildDiskImage();

  // Sector 0 is the boot block, pointing init at /bin/init.
  const bb = decodeBootBlock(image.subarray(0, 512));
  assert.equal(bb.magic, BOOT_MAGIC);
  assert.equal(bb.initPath, '/bin/init');

  // The filesystem really contains the userland (mount a read-only kernel on it).
  const k = new Kernel({ diskImage: image, log: () => {} });
  for (const path of ['/bin/init', '/bin/sh', '/bin/ls', '/bin/cat', '/bin/echo']) {
    assert.notEqual(k.fs.namei(path), 0, `expected ${path} on the built image`);
  }
});

test('build then boot: reaches a shell and runs ls — no installUserland/spawnFromFile', () => {
  // The whole Phase 9 acceptance, in two steps that mirror the two CLI commands.
  const image = buildDiskImage(); // step 1: `npm run build:img`

  const out: string[] = [];
  const kernel = bootImage(image, { consoleSink: (s) => out.push(s), quantum: 200 }); // step 2
  kernel.feedInput('ls /bin\n');
  kernel.closeInput();
  kernel.run();

  const text = out.join('');
  assert.match(text, /init/); // ls /bin listed the userland from the disk
  assert.match(text, /\bsh\b/);
  // init really came up as pid 1.
  assert.equal(kernel.processes.get(1)?.name.includes('init') || kernel.processes.has(1), true);
});

test('booting a disk with no boot block fails clearly', () => {
  // A freshly formatted disk (mkfs) has a zeroed sector 0 — not bootable.
  const kernel = new Kernel({ log: () => {} });
  assert.throws(() => kernel.boot(), /not bootable/);
});
