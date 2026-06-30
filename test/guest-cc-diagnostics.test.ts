// Diagnostics legibility: the guest `cc` reports errors through chibicc's
// `verror_at`, which prints the offending source line with `%.*s` and indents a
// `^` caret with `%*s`. Those rely on the guest libc's printf honoring field
// width and precision (including the `*` form). When it did not, every compile
// error printed the literal text `%.*s` / `%*s` instead of the source line and
// caret, making in-guest build failures nearly impossible to localize. This test
// pins the readable form, and exercises the guest `cc -v` progress trace.

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

test('guest cc prints a legible source-line + caret diagnostic (printf width/precision)', () => {
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  const fs = installFs(disk);
  installChibiccToolchain(fs);
  // A call to an undeclared function: chibicc's parser routes this through
  // error_tok -> verror_at, the exact path that prints the source line + caret.
  fs.writeFile(
    '/bad.c',
    new TextEncoder().encode('int main(void) {\n  return undefined_fn(0);\n}\n'),
  );

  const out = bootAndRun(disk, 'cc -S -o /bad.s /bad.c\necho cc-exited');

  assert.ok(out.includes('cc-exited\n'), `shell did not continue after cc:\n${out}`);
  // The real diagnostic text, not the unformatted conversion specifiers.
  assert.ok(out.includes('implicit declaration of a function'), out);
  // %.*s must render the actual source line...
  assert.ok(out.includes('return undefined_fn(0);'), `source line not rendered:\n${out}`);
  // ...and %*s must indent a caret to the failing token (not print "%*s^").
  assert.ok(/\n\s+\^ implicit declaration/.test(out), `caret not indented:\n${out}`);
  assert.equal(out.includes('%.*s'), false, `literal %.*s leaked into output:\n${out}`);
  assert.equal(out.includes('%*s'), false, `literal %*s leaked into output:\n${out}`);
});

test('guest cc -v traces each compile phase to stderr', () => {
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  const fs = installFs(disk);
  installChibiccToolchain(fs);
  fs.writeFile('/ok.c', new TextEncoder().encode('int main(void) { return 7; }\n'));

  const out = bootAndRun(disk, 'cc -v -S -o /ok.s /ok.c\necho cc-exited');

  assert.ok(out.includes('cc-exited\n'), out);
  for (const phase of ['tokenize', 'preprocess', 'parse', 'codegen', 'done']) {
    assert.ok(out.includes(`cc: ${phase}`), `missing '${phase}' phase trace in:\n${out}`);
  }
});
