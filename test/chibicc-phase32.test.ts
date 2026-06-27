import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import { crt0Object } from '../src/toolchain/cc.ts';
import { compile, compileObject } from '../src/toolchain/chibicc/index.ts';
import { linkGuestExecutable } from '../src/v3/guest-cc.ts';
import {
  buildGuestDiskImage,
  buildGuestKernelImage,
  GUEST_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

const PHASE32_SRC = `
typedef struct Pair Pair;
typedef int (*op)(int, int);

struct Pair {
  char tag;
  int a;
  short b;
};

enum {
  BASE = 3,
  STEP = BASE + 4,
};

Pair global = { 1, 40, 2 };
char word[4] = "abc";
op ops[2];

int add(int a, int b) { return a + b; }
int mul(int a, int b) { return a * b; }

int slen(char *s) {
  int n = 0;
  while (s[n]) { n = n + 1; }
  return n;
}

int puts(char *s) { return __syscall(1, 1, s, slen(s)); }

int putnum(int v) {
  char buf[12];
  int i = 11;
  buf[11] = 0;
  if (v == 0) { return puts("0"); }
  while (v > 0) {
    i = i - 1;
    buf[i] = 48 + v % 10;
    v = v / 10;
  }
  return puts(buf + i);
}

int main(void) {
  Pair p = { 2, 5, 6 };
  Pair *pp = &p;
  op fp = add;
  ops[0] = add;
  ops[1] = mul;
  int total = sizeof(Pair) + sizeof(p.tag) + pp->a + p.b + global.a + global.b + word[1] + STEP;
  total = total + ops[0](4, 5) + ops[1](6, 7) + fp(10, 5);
  puts("phase32=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const UNSIGNED_SRC = `
int slen(char *s) {
  int n = 0;
  while (s[n]) { n = n + 1; }
  return n;
}

int puts(char *s) { return __syscall(1, 1, s, slen(s)); }

int putnum(int v) {
  char buf[12];
  int i = 11;
  buf[11] = 0;
  if (v == 0) { return puts("0"); }
  while (v > 0) {
    i = i - 1;
    buf[i] = 48 + v % 10;
    v = v / 10;
  }
  return puts(buf + i);
}

int main(void) {
  unsigned int big = 4000000000u;
  unsigned int small = 3u;
  unsigned char byte = 255;
  unsigned short half = 65535;
  int total = 0;
  if (big > small) { total = total + 1; }
  if (big / 2u == 2000000000u) { total = total + 2; }
  if (big >> 1 == 2000000000u) { total = total + 4; }
  if (byte == 255) { total = total + 8; }
  if (half == 65535) { total = total + 16; }
  puts("unsigned=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const STATIC_CAST_SRC = `
int slen(char *s) {
  int n = 0;
  while (s[n]) { n = n + 1; }
  return n;
}

int puts(char *s) { return __syscall(1, 1, s, slen(s)); }

int putnum(int v) {
  char buf[12];
  int i = 11;
  buf[11] = 0;
  if (v == 0) { return puts("0"); }
  while (v > 0) {
    i = i - 1;
    buf[i] = 48 + v % 10;
    v = v / 10;
  }
  return puts(buf + i);
}

int bump(void) {
  static int counter = 4;
  counter = counter + 1;
  return counter;
}

int main(void) {
  int total = 0;
  total = total + bump();
  total = total + bump();
  if ((unsigned char)300 == 44) { total = total + 10; }
  if ((char)255 < 0) { total = total + 20; }
  if ((unsigned int)-1 > 1u) { total = total + 30; }
  puts("static-cast=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

function linkProgram(src: string, name: string): Uint8Array {
  return linkGuestExecutable([crt0Object(), compileObject(src, { name })]);
}

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
  const result = machine.run(60_000_000);
  assert.equal(result.reason, 'halt');
  return out;
}

test('chibicc Phase 32 frontend accepts typedef, enum, struct, and initializers', () => {
  const asm = compile(PHASE32_SRC);
  assert.match(asm, /\.global main/);
  assert.match(asm, /\.global global/);
  assert.match(asm, /LHS R0, R0/);
  assert.match(asm, /SH R1, R0/);
  assert.match(asm, /CALLR R0/);
  const unsignedAsm = compile(UNSIGNED_SRC);
  assert.match(unsignedAsm, /DIV R0, R1/);
  assert.match(unsignedAsm, /SHR R0, R1/);
  assert.match(unsignedAsm, /JB|JBE/);
  assert.match(unsignedAsm, /LB R0, R0/);
  assert.match(unsignedAsm, /LH R0, R0/);
  const staticCastAsm = compile(STATIC_CAST_SRC);
  assert.match(staticCastAsm, /\.L\.static\.bump\.counter/);
  assert.match(staticCastAsm, /MOV R7, 255/);
  assert.match(staticCastAsm, /MOV R7, 4294967040/);
  assert.match(compile('typedef int T; int main(void) { T T = 4; return T; }'), /MOV R0, 4/);
});

test('chibicc Phase 32 aggregate program runs deterministically in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/phase32', linkProgram(PHASE32_SRC, 'phase32.o'));
  fs.chmod('/bin/phase32', 0o755);

  const out = bootAndRun(disk, 'phase32');
  assert.ok(out.includes('phase32=237\n'), `missing phase32 result in:\n${out}`);
});

test('chibicc Phase 32 unsigned arithmetic and zero-extension run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/unsigned', linkProgram(UNSIGNED_SRC, 'unsigned.o'));
  fs.chmod('/bin/unsigned', 0o755);

  const out = bootAndRun(disk, 'unsigned');
  assert.ok(out.includes('unsigned=31\n'), `missing unsigned result in:\n${out}`);
});

test('chibicc Phase 32 static locals and casts run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/static-cast', linkProgram(STATIC_CAST_SRC, 'static-cast.o'));
  fs.chmod('/bin/static-cast', 0o755);

  const out = bootAndRun(disk, 'static-cast');
  assert.ok(out.includes('static-cast=71\n'), `missing static/cast result in:\n${out}`);
});
