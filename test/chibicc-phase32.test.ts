import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import { compileObject as bootstrapCompileObject, crt0Object } from '../src/toolchain/cc.ts';
import { compile, compileObject } from '../src/toolchain/chibicc/index.ts';
import { floatRuntimeArchive, floatRuntimeObject } from '../src/toolchain/chibicc/runtimeFloat.ts';
import { i64RuntimeObject } from '../src/toolchain/chibicc/runtime64.ts';
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

const DECLARATOR_SRC = `
int storage[3];
int *get_storage(void) { return storage; }
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
  storage[0] = 10;
  storage[1] = 20;
  storage[2] = 30;
  int (*ap)[3] = &storage;           /* pointer to array of 3 int */
  int *p = get_storage();            /* function returning pointer */
  typedef int (*binop)(int, int);    /* nested function-pointer typedef */
  binop ops[2];
  ops[0] = add;
  ops[1] = mul;
  int total = (*ap)[1] + p[2];           /* 20 + 30 = 50 */
  total = total + sizeof(int (*)(int));  /* abstract declarator: + 4 = 54 */
  total = total + ops[0](3, 4);          /* + 7 = 61 */
  total = total + ops[1](2, 3);          /* + 6 = 67 */
  puts("declarator=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const INITIALIZER_SRC = `
struct Point { int x; int y; int z; };

int gnum = 42;
int *pnum = &gnum;                 /* pointer to a global */
char *greeting = "Hi";             /* pointer to a string literal */
char *names[2] = { "ab", "cde" };  /* array of string pointers */
struct Point gp = { .z = 3, .x = 1 };  /* designated, y zero-filled */
int arr[4] = { 0, 0, 7, 0 };
int *mid = &arr[2];                /* &g[i] with a byte addend */
int one(void) { return 1; }
int (*fp)(void) = one;             /* function-pointer initializer */

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
  total = total + *pnum;                       /* 42 */
  total = total + slen(greeting);              /* + 2 = 44 */
  total = total + slen(names[0]) + slen(names[1]); /* + 2 + 3 = 49 */
  total = total + gp.x + gp.y + gp.z;          /* 1 + 0 + 3 = + 4 = 53 */
  int a[4] = { [1] = 10, [3] = 30 };           /* local designated + zero-fill */
  total = total + a[0] + a[1] + a[2] + a[3];   /* 0+10+0+30 = + 40 = 93 */
  struct Point lp = { .y = 5 };                /* local zero-fill */
  total = total + lp.x + lp.y + lp.z;          /* + 5 = 98 */
  total = total + fp();                        /* + 1 = 99 */
  total = total + *mid;                        /* arr[2] = 7 -> + 7 = 106 */
  puts("init=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const PROMO_SRC = `
unsigned char uc = 10;
unsigned short us = 60000;

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
  if ((uc - 20) / 3 == -3) { total = total + 1; }   /* signed division after promotion */
  if (uc - 20 < 0) { total = total + 2; }           /* signed comparison after promotion */
  if (us * 2 == 120000) { total = total + 4; }      /* short promotes to int, no wrap */
  unsigned int u = 1u;
  int neg = -1;
  if (neg > u) { total = total + 8; }               /* mixed: unsigned comparison */
  if ((unsigned char)-1 == 255) { total = total + 16; }
  if ((uc - 20) >> 1 == -5) { total = total + 32; } /* arithmetic right shift after promotion */
  puts("promo=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const LONGLONG_SRC = `
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

long long mulwide(long long a, long long b) { return a * b; }

int main(void) {
  long long a = 1000000000;      /* 1e9 */
  long long c = a * 5;           /* 5e9, exceeds 32 bits */
  long long d = c / 7;           /* 714285714 */
  long long e = c % 7;           /* 2 */
  int total = 0;
  if (c == 5000000000LL) { total = total + 1; }
  if (c > a) { total = total + 2; }
  if (d == 714285714LL) { total = total + 4; }
  if (e == 2) { total = total + 8; }
  long long neg = 0 - c;
  if (neg < 0) { total = total + 16; }
  long long sh = c >> 1;         /* 2500000000 */
  if (sh == 2500000000LL) { total = total + 32; }
  long long f = mulwide(a, 6);   /* 6e9, passed/returned as two words */
  if (f == 6000000000LL) { total = total + 64; }
  int lo = (int)c;               /* low 32 bits of 5e9 = 705032704 */
  if (lo == 705032704) { total = total + 128; }
  puts("ll=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const AGGREGATE_CALL_RETURN_SRC = `
struct Pair { int a; char b; };
struct Big { int a; int b; int c; };

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

int sum_pair(struct Pair p) { return p.a + p.b + sizeof(struct Pair); }

struct Pair make_pair(int a, int b) {
  struct Pair p = { a, b };
  return p;
}

struct Big make_big(int x) {
  return (struct Big){ x, x + 1, x + 2 };
}

int main(void) {
  struct Pair p = { 10, 3 };
  struct Pair q = make_pair(20, 4);
  struct Big b = make_big(5);
  int total = sum_pair(p) + sum_pair(q) + q.b + b.a + b.b + b.c;
  puts("aggregate-call=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const BITFIELD_SRC = `
struct Flags {
  unsigned int a:3;
  signed int b:5;
  unsigned int :0;
  unsigned int c:6;
  int d;
};

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
  struct Flags f;
  f.a = 15;
  f.b = -3;
  f.c = 63;
  f.d = 5;
  int total = f.a + f.c + f.d + sizeof(struct Flags);
  if (f.b < 0) { total = total + 10; }
  f.b = 31;
  if (f.b == -1) { total = total + 20; }
  puts("bitfield=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const COMPOUND_VLA_SRC = `
struct Point { int x; int y; };
struct Point *gp = &(struct Point){ .x = 2, .y = 3 };

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
  int n = 5;
  int a[n];
  int i = 0;
  while (i < n) {
    a[i] = i * 2;
    i = i + 1;
  }
  struct Point p = (struct Point){ .y = 7, .x = 4 };
  struct Point *lp = &(struct Point){ 8, 9 };
  int total = sizeof(a) + a[3] + p.x + p.y + gp->x + gp->y + lp->x + lp->y;
  puts("compound-vla=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const VARIADIC_SRC = `
#include <stdarg.h>

struct Pair { int a; int b; };

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

int collect(int fixed, ...) {
  va_list ap;
  va_start(ap, fixed);
  int a = va_arg(ap, int);
  long long wide = va_arg(ap, long long);
  char *s = va_arg(ap, char *);
  struct Pair p = va_arg(ap, struct Pair);
  va_end(ap);
  return fixed + a + (int)wide + s[1] + p.a + p.b;
}

int main(void) {
  struct Pair p = { 2, 4 };
  int total = collect(5, 7, 40LL, "az", p);
  puts("variadic=");
  putnum(total);
  puts("\\n");
  return total;
}
`;

const BOOTSTRAP_ABI_CALLER_SRC = `
extern int mix(int a, int b, int c);

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
  puts("boot-to-chibicc=");
  putnum(mix(1, 2, 3));
  puts("\\n");
  return 0;
}
`;

const CHIBICC_ABI_CALLER_SRC = `
extern int bmix(int a, int b, int c);

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
  puts("chibicc-to-boot=");
  putnum(bmix(4, 5, 6));
  puts("\\n");
  return 0;
}
`;

function linkProgram(src: string, name: string): Uint8Array {
  return linkGuestExecutable([crt0Object(), compileObject(src, { name })]);
}

function linkProgramWith64(src: string, name: string): Uint8Array {
  return linkGuestExecutable([crt0Object(), compileObject(src, { name }), i64RuntimeObject()]);
}

function linkProgramWithFloat(src: string, name: string): Uint8Array {
  return linkGuestExecutable(
    [crt0Object(), compileObject(src, { name }), i64RuntimeObject()],
    [floatRuntimeArchive()],
  );
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
  assert.throws(() => compile('#include "x.h"\n'), /cannot find include/);
  // Declarators: pointer-to-array, function-returning-pointer, abstract types.
  assert.equal(
    compile('int main(void) { return sizeof(int (*)(int)); }').match(/MOV R0, 4/)?.length,
    1,
  );
  assert.doesNotThrow(() =>
    compile('int g[3]; int (*ap)[3]; int *f(void){return g;} int main(void){return 0;}'),
  );
  assert.match(compile(DECLARATOR_SRC), /\.global get_storage/);
  // Initializers: pointer/address globals emit relocations; designators parse.
  const initAsm = compile(INITIALIZER_SRC);
  assert.match(initAsm, /\.word gnum/); // pnum = &gnum
  assert.match(initAsm, /\.word arr\+8/); // mid = &arr[2]
  assert.match(initAsm, /\.word one/); // fp = one
  assert.match(initAsm, /\.word \.L\.str\.\d+/); // greeting/names string pointers
  assert.match(
    compile('struct S{int x;int y;}; struct S s = {.y=9}; int main(void){return s.y;}'),
    /\.global s/,
  );
  // Integer promotion: unsigned char/short promote to signed int, so arithmetic
  // uses signed division (IDIV) rather than unsigned (DIV).
  assert.match(compile('unsigned char c; int main(void){ return (c - 20) / 3; }'), /IDIV/);
  assert.doesNotMatch(
    compile('unsigned char c; int main(void){ return (c - 20) / 3; }'),
    /\bDIV R0/,
  );
  // ...but unsigned int stays unsigned.
  assert.match(compile('unsigned int u; int main(void){ return u / 3; }'), /\bDIV R0/);
  // long long: 8-byte type, helper-based arithmetic, two-word ABI.
  const llAsm = compile('long long f(long long a, long long b){ return a * b; }');
  assert.match(llAsm, /CALL __i64_mul/);
  assert.match(compile('long long f(long long a){ return a / 3; }'), /CALL __i64_div/);
  assert.match(
    compile('unsigned long long f(unsigned long long a){ return a / 3; }'),
    /CALL __u64_div/,
  );
  assert.equal(compile('int f(void){ return sizeof(long long); }').match(/MOV R0, 8/)?.length, 1);
  assert.doesNotThrow(() => i64RuntimeObject());
  // Remaining Phase 32 language slices: aggregate calls/returns, bit-fields,
  // compound literals, and VLA runtime sizing.
  assert.match(compile(AGGREGATE_CALL_RETURN_SRC), /CALL make_big/);
  assert.match(compile(BITFIELD_SRC), /SHL R5, R7/);
  const compoundVlaAsm = compile(COMPOUND_VLA_SRC);
  assert.match(compoundVlaAsm, /\.L\.compound\./);
  assert.match(compoundVlaAsm, /STORE R5, __csp/);
  assert.doesNotThrow(() => compile('int f(int a, ...){ return a; }'));
  assert.match(compile(VARIADIC_SRC), /LOADR R0, R0/);
  const floatAsm = compile('float f(float a, float b){ return a + b; }');
  assert.match(floatAsm, /CALL __addsf3/);
  const doubleAsm = compile('double f(double a, double b){ return a * b; }');
  assert.match(doubleAsm, /CALL __muldf3/);
  assert.doesNotThrow(() => floatRuntimeObject());
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

test('chibicc Phase 32 long long arithmetic runs in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/ll', linkProgramWith64(LONGLONG_SRC, 'll.o'));
  fs.chmod('/bin/ll', 0o755);

  const out = bootAndRun(disk, 'll');
  assert.ok(out.includes('ll=255\n'), `missing long long result in:\n${out}`);
});

test('chibicc Phase 32 float and double soft-float run in the guest', () => {
  const io = `
int slen(char *s) { int n = 0; while (s[n]) n = n + 1; return n; }
int puts(char *s) { return __syscall(1, 1, s, slen(s)); }
int putnum(int v) {
  char buf[12]; int i = 11; buf[11] = 0;
  if (v == 0) return puts("0");
  while (v > 0) { i = i - 1; buf[i] = 48 + v % 10; v = v / 10; }
  return puts(buf + i);
}
`;
  const floatSrc = `${io}
int main(void) {
  float a = 1.5f;
  float b = 2.5f;
  int total = (int)(a + b);
  total = total + (int)(b * 4.0f);
  total = total + (a < b);
  puts("float=");
  putnum(total);
  puts("\\n");
  return total;
}
`;
  const doubleSrc = `${io}
int main(void) {
  double big = 9007199254740992.0;
  int total = (int)((big + 2.0) - big);
  puts("double=");
  putnum(total);
  puts("\\n");
  return total;
}
`;
  const variadicSrc = `#include <stdarg.h>
${io}
int vf(int n, ...) {
  va_list ap;
  va_start(ap, n);
  double d = va_arg(ap, double);
  return (int)d;
}
int main(void) {
  float b = 2.5f;
  int total = vf(1, b);
  puts("varf=");
  putnum(total);
  puts("\\n");
  return total;
}
`;
  const lateSrc = `${io}
int main(void) {
  float b = 2.5f;
  int total = late_float_arg(b);
  puts("late=");
  putnum(total);
  puts("\\n");
  return total;
}
int late_float_arg(double d) { return (int)d; }
`;
  const edgeSrc = `${io}
int main(void) {
  double inf = 1.0 / 0.0;
  double nan = 0.0 / 0.0;
  int total = 0;
  if (inf > 1.0) total = total + 1;
  if (nan != nan) total = total + 2;
  if (!(nan == nan)) total = total + 4;
  puts("edge=");
  putnum(total);
  puts("\\n");
  return total;
}
`;
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/float', linkProgramWithFloat(floatSrc, 'float.o'));
  fs.chmod('/bin/float', 0o755);
  fs.writeFile('/bin/double', linkProgramWithFloat(doubleSrc, 'double.o'));
  fs.chmod('/bin/double', 0o755);
  fs.writeFile('/bin/varf', linkProgramWithFloat(variadicSrc, 'varf.o'));
  fs.chmod('/bin/varf', 0o755);
  fs.writeFile('/bin/latef', linkProgramWithFloat(lateSrc, 'latef.o'));
  fs.chmod('/bin/latef', 0o755);
  fs.writeFile('/bin/fedge', linkProgramWithFloat(edgeSrc, 'fedge.o'));
  fs.chmod('/bin/fedge', 0o755);

  const out = bootAndRun(disk, 'float');
  assert.ok(out.includes('float=15\n'), `missing float result in:\n${out}`);
  assert.ok(bootAndRun(disk, 'double').includes('double=2\n'));
  assert.ok(bootAndRun(disk, 'varf').includes('varf=2\n'));
  assert.ok(bootAndRun(disk, 'latef').includes('late=2\n'));
  assert.ok(bootAndRun(disk, 'fedge').includes('edge=7\n'));
});

test('chibicc Phase 32 integer promotions run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/promo', linkProgram(PROMO_SRC, 'promo.o'));
  fs.chmod('/bin/promo', 0o755);

  const out = bootAndRun(disk, 'promo');
  assert.ok(out.includes('promo=63\n'), `missing promotion result in:\n${out}`);
});

test('chibicc Phase 32 initializers run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/initz', linkProgram(INITIALIZER_SRC, 'initz.o'));
  fs.chmod('/bin/initz', 0o755);

  const out = bootAndRun(disk, 'initz');
  assert.ok(out.includes('init=106\n'), `missing initializer result in:\n${out}`);
});

test('chibicc Phase 32 complex declarators run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/declarator', linkProgram(DECLARATOR_SRC, 'declarator.o'));
  fs.chmod('/bin/declarator', 0o755);

  const out = bootAndRun(disk, 'declarator');
  assert.ok(out.includes('declarator=67\n'), `missing declarator result in:\n${out}`);
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

test('chibicc Phase 32 aggregate call and return ABI runs in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/aggregate-call', linkProgram(AGGREGATE_CALL_RETURN_SRC, 'aggregate-call.o'));
  fs.chmod('/bin/aggregate-call', 0o755);

  const out = bootAndRun(disk, 'aggregate-call');
  assert.ok(out.includes('aggregate-call=75\n'), `missing aggregate result in:\n${out}`);
});

test('chibicc Phase 32 bit-fields run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/bitfield', linkProgram(BITFIELD_SRC, 'bitfield.o'));
  fs.chmod('/bin/bitfield', 0o755);

  const out = bootAndRun(disk, 'bitfield');
  assert.ok(out.includes('bitfield=117\n'), `missing bitfield result in:\n${out}`);
});

test('chibicc Phase 32 compound literals and VLAs run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/compound-vla', linkProgram(COMPOUND_VLA_SRC, 'compound-vla.o'));
  fs.chmod('/bin/compound-vla', 0o755);

  const out = bootAndRun(disk, 'compound-vla');
  assert.ok(out.includes('compound-vla=59\n'), `missing compound/VLA result in:\n${out}`);
});

test('chibicc Phase 32 variadic va_list traversal runs in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/variadic', linkProgram(VARIADIC_SRC, 'variadic.o'));
  fs.chmod('/bin/variadic', 0o755);

  const out = bootAndRun(disk, 'variadic');
  assert.ok(out.includes('variadic=180\n'), `missing variadic result in:\n${out}`);
});

test('chibicc Phase 32 right-to-left ABI crosses bootstrap and chibicc objects', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile(
    '/bin/b2c',
    linkGuestExecutable([
      crt0Object(),
      bootstrapCompileObject(BOOTSTRAP_ABI_CALLER_SRC, {
        name: 'boot-caller.o',
        moduleId: 'bootcaller',
      }),
      compileObject('int mix(int a, int b, int c) { return a * 100 + b * 10 + c; }', {
        name: 'chibicc-callee.o',
      }),
    ]),
  );
  fs.chmod('/bin/b2c', 0o755);
  fs.writeFile(
    '/bin/c2b',
    linkGuestExecutable([
      crt0Object(),
      compileObject(CHIBICC_ABI_CALLER_SRC, { name: 'chibicc-caller.o' }),
      bootstrapCompileObject('int bmix(int a, int b, int c) { return a * 100 + b * 10 + c; }', {
        name: 'boot-callee.o',
        moduleId: 'bootcallee',
      }),
    ]),
  );
  fs.chmod('/bin/c2b', 0o755);

  const out1 = bootAndRun(disk, 'b2c');
  assert.ok(out1.includes('boot-to-chibicc=123\n'), `missing bootstrap->chibicc ABI in:\n${out1}`);
  const out2 = bootAndRun(disk, 'c2b');
  assert.ok(out2.includes('chibicc-to-boot=456\n'), `missing chibicc->bootstrap ABI in:\n${out2}`);
});
