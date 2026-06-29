// End-to-end "separate compilation" suite for the guest toolchain.
//
// Exercises the three pieces the guest `cc` gained: `-c` relocatable `.o`
// output, multi-input linking of those objects, and the standalone `/bin/as`
// and `/bin/ld`. A two translation-unit program (helpers in one file, `main`
// in another, cross-referencing each other) is built two ways entirely inside
// the emulated OS, and each resulting executable is run and checked against a
// known-good string, so a bad object format or relocation shows up as a wrong
// answer rather than just a crash.

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

// One translation unit of small freestanding helpers (string length, decimal
// print) plus two arithmetic functions. `main` lives in the other unit and
// reaches these by `extern`, so the link must resolve cross-unit globals. Only
// `write` (supplied by the linker's built-in crt) is used as a library symbol.
const HELPERS_SRC = `
extern int write(int fd, char *buf, int n);
typedef unsigned int u32;
int slen(char *s){ int n=0; while(s[n]) n++; return n; }
void puts2(char *s){ write(1, s, slen(s)); }
void putint(int n){
  char buf[16]; int i=15; u32 u;
  buf[i]=0;
  if(n==0){ i--; buf[i]='0'; }
  u=(u32)n;
  while(u>0){ i--; buf[i]=(char)('0'+(u%10)); u=u/10; }
  write(1, buf+i, 15-i);
}
int add(int a, int b){ return a+b; }
int mul(int a, int b){ return a*b; }
`;

const APP_SRC = `
extern void puts2(char *s);
extern void putint(int n);
extern int add(int a, int b);
extern int mul(int a, int b);
int main(void){
  puts2("sum="); putint(add(3, 4));
  puts2(" prod="); putint(mul(3, 4));
  puts2("\\n");
  return 0;
}
`;

const EXPECT = 'sum=7 prod=12';

function bootAndRun(disk: Uint8Array, script: string[], budget = 6_000_000_000): string {
  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
  });
  machine.keyboard.feed(`${script.join('\n')}\n`);
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });
  const result = machine.run(budget);
  assert.equal(result.reason, 'halt', `VM stopped with ${result.reason}; output:\n${out}`);
  assert.equal(out.includes('cc:'), false, `cc reported an error:\n${out}`);
  assert.equal(out.includes('as:'), false, `as reported an error:\n${out}`);
  assert.equal(out.includes('ld:'), false, `ld reported an error:\n${out}`);
  assert.equal(out.includes('PANIC'), false, `kernel panicked:\n${out}`);
  return out;
}

test('guest cc -c emits objects that link across translation units and run', () => {
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  const fs = installFs(disk);
  installChibiccToolchain(fs);
  const enc = new TextEncoder();
  fs.writeFile('/helpers.c', enc.encode(HELPERS_SRC));
  fs.writeFile('/app.c', enc.encode(APP_SRC));

  const out = bootAndRun(disk, [
    // -c with an explicit object name, and -c with the default `.o` name.
    'cc -c -o /helpers.o /helpers.c',
    'cc -c /app.c',
    // Multi-input link of the two objects (crt auto-supplied by the linker).
    'cc -o /prog /app.o /helpers.o',
    'echo ===CC===',
    '/prog',
    'echo ===DONE===',
  ]);

  assert.ok(out.includes('===DONE===\n'), `build did not finish; output:\n${out}`);
  assert.ok(
    out.includes(`===CC===\n${EXPECT}`),
    `multi-object link did not produce "${EXPECT}"\n--- output ---\n${out}`,
  );
});

test('standalone guest as and ld assemble and link a multi-unit program', () => {
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  const fs = installFs(disk);
  installChibiccToolchain(fs);
  const enc = new TextEncoder();
  fs.writeFile('/helpers.c', enc.encode(HELPERS_SRC));
  fs.writeFile('/app.c', enc.encode(APP_SRC));

  const out = bootAndRun(disk, [
    // Compile each unit to assembly, assemble with the standalone `as`, then
    // link the objects with the standalone `ld`.
    'cc -S -o /helpers.s /helpers.c',
    'cc -S -o /app.s /app.c',
    'as -o /helpers.o /helpers.s',
    'as -o /app.o /app.s',
    'ld -o /prog /app.o /helpers.o',
    'echo ===LD===',
    '/prog',
    'echo ===DONE===',
  ]);

  assert.ok(out.includes('===DONE===\n'), `build did not finish; output:\n${out}`);
  assert.ok(
    out.includes(`===LD===\n${EXPECT}`),
    `as/ld build did not produce "${EXPECT}"\n--- output ---\n${out}`,
  );
});
