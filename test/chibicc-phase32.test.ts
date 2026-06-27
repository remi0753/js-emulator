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
int (*direct_ops[2])(int, int);

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
  direct_ops[0] = add;
  direct_ops[1] = mul;
  int total = sizeof(Pair) + sizeof(p.tag) + pp->a + p.b + global.a + global.b + word[1] + STEP;
  total = total + ops[0](4, 5) + ops[1](6, 7) + fp(10, 5);
  total = total + direct_ops[0](3, 4) + direct_ops[1](2, 8);
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

const PREPROCESSOR_SRC = `
#define ENABLED 1
#define WIDTH 4
#define ADD(a, b) ((a) + (b))
#define SQUARE(x) ((x) * (x))
#define VALUE() 6

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
  int total = 0;
#if ENABLED && WIDTH * 2 == 8
  total = total + 1;
#else
  total = total + missing_symbol;
#endif
#ifdef ENABLED
  total = total + 2;
#endif
#ifndef DISABLED
  total = total + 4;
#endif
#if 0
  total = total + missing_symbol;
#elif defined(ENABLED)
  total = total + 8;
#else
  total = total + missing_symbol;
#endif
  total = total + ADD(2, 3);
  total = total + SQUARE(WIDTH);
  total = total + VALUE();
  puts("preproc=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const CONTROL_SRC = `
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

int classify(int x) {
  int r = 0;
  switch (x) {
  case 0:
    r = 1;
    break;
  case 1:
    r = r + 2;
  case 2:
    r = r + 4;
    break;
  default:
    r = 8;
  }
  return r;
}

int main(void) {
  int i = 0;
  int total = 0;
  do {
    total = total + classify(i);
    i = i + 1;
  } while (i < 4);
  puts("control=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const PREPROCESSOR2_HEADERS = new Map<string, string>([
  [
    'calc.h',
    `#ifndef CALC_H
#define CALC_H
#define TRIPLE(x) ((x) * 3)
#define SEVEN 7
#endif
`,
  ],
]);

const resolvePreproc2Include = (name: string) => {
  const text = PREPROCESSOR2_HEADERS.get(name);
  return text === undefined ? undefined : { path: name, text };
};

const PREPROCESSOR2_SRC = `
#include "calc.h"
#include "calc.h"

#define STR(x) #x
#define CONCAT(a, b) a ## b

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

int CONCAT(answer, fn)(void) { return 20; }

int main(void) {
  int total = TRIPLE(4) + answerfn() + slen(STR(abc)) + SEVEN;
  puts("preproc2=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

function linkProgram(src: string, name: string): Uint8Array {
  return linkGuestExecutable([crt0Object(), compileObject(src, { name })]);
}

function linkProgramWithIncludes(src: string, name: string): Uint8Array {
  return linkGuestExecutable([
    crt0Object(),
    compileObject(src, { name, resolveInclude: resolvePreproc2Include }),
  ]);
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
  assert.doesNotMatch(compile(PREPROCESSOR_SRC), /missing_symbol/);
  assert.throws(() => compile('#if 1\nint main(void) { return 0; }\n'), /unterminated conditional/);
  assert.throws(
    () => compile('#define ADD(a,b) (a+b)\nint main(void) { return ADD(1); }\n'),
    /expects 2 arguments/,
  );
  assert.match(compile('typedef int T; int main(void) { T T = 4; return T; }'), /MOV R0, 4/);
  // Preprocessor: #include + guards, # stringize, ## paste.
  const preproc2Asm = compile(PREPROCESSOR2_SRC, { resolveInclude: resolvePreproc2Include });
  assert.match(preproc2Asm, /\.global answerfn/);
  assert.doesNotMatch(preproc2Asm, /TRIPLE|CONCAT/);
  assert.throws(
    () => compile('#include "missing.h"\n', { resolveInclude: () => undefined }),
    /cannot find include/,
  );
  assert.throws(() => compile('#include "x.h"\n'), /not supported/);
});

test('chibicc Phase 32 aggregate program runs deterministically in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/phase32', linkProgram(PHASE32_SRC, 'phase32.o'));
  fs.chmod('/bin/phase32', 0o755);

  const out = bootAndRun(disk, 'phase32');
  assert.ok(out.includes('phase32=260\n'), `missing phase32 result in:\n${out}`);
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

test('chibicc Phase 32 conditional preprocessing runs in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/preproc', linkProgram(PREPROCESSOR_SRC, 'preproc.o'));
  fs.chmod('/bin/preproc', 0o755);

  const out = bootAndRun(disk, 'preproc');
  assert.ok(out.includes('preproc=42\n'), `missing preprocessor result in:\n${out}`);
});

test('chibicc Phase 32 preprocessor includes, stringize, and paste run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/preproc2', linkProgramWithIncludes(PREPROCESSOR2_SRC, 'preproc2.o'));
  fs.chmod('/bin/preproc2', 0o755);

  const out = bootAndRun(disk, 'preproc2');
  assert.ok(out.includes('preproc2=42\n'), `missing preprocessor2 result in:\n${out}`);
});

test('chibicc Phase 32 do-while and switch run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/control', linkProgram(CONTROL_SRC, 'control.o'));
  fs.chmod('/bin/control', 0o755);

  const out = bootAndRun(disk, 'control');
  assert.ok(out.includes('control=19\n'), `missing control result in:\n${out}`);
});
