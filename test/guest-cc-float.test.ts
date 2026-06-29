// Floating point and variadics in the guest compiler.
//
// The guest `/bin/cc` now lowers float/double through the soft-float runtime
// (the backend carries IEEE-754 bits through the integer ABI and calls
// __addsf3/__adddf3/__divdf3/... ), and `cc -o` links that runtime (plus the
// 64-bit helpers it needs) from /lib on demand. Variadics ride the macro-based
// <stdarg.h> and the right-to-left arg ABI, so a variadic `double` argument also
// works. Each program prints scaled integers so a miscompile is a wrong number,
// not just a crash.

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

const PRELUDE = `
#include <stdarg.h>
extern int write(int fd, char *buf, int n);
int slen(char *s){int n=0;while(s[n])n++;return n;}
void puts2(char *s){write(1,s,slen(s));}
void putint(int n){
  char buf[16]; int i=15; unsigned u;
  buf[i]=0;
  if(n<0){write(1,"-",1);u=(unsigned)(-n);}else u=(unsigned)n;
  if(u==0){i--;buf[i]='0';}
  while(u>0){i--;buf[i]=(char)('0'+(u%10));u=u/10;}
  write(1,buf+i,15-i);
}
void line(char *t,int v){puts2(t);putint(v);puts2("\\n");}
// Variadic accumulators: exercise va_arg(ap, int) and va_arg(ap, double).
int vsumi(int count, ...){
  va_list ap; va_start(ap,count); int s=0;
  for(int i=0;i<count;i++) s += va_arg(ap,int);
  va_end(ap); return s;
}
double vsumd(int count, ...){
  va_list ap; va_start(ap,count); double s=0.0;
  for(int i=0;i<count;i++) s += va_arg(ap,double);
  va_end(ap); return s;
}
`;

const PROG = `
int main(void){
  // int -> double -> divide -> multiply -> back to int.
  int a=7, b=2;
  double x=a, y=b;
  line("div", (int)(x/y*1000000.0 + 0.5));      // 3.5e6

  // double division that needs the quotient's integer bit (regression for the
  // soft-float __divdf3 off-by-one).
  line("d6_2", (int)(6.0/2.0));                  // 3
  line("d7_2", (int)(7.0/2.0*100.0));            // 350

  // float literal precision and float arithmetic.
  float f=1.5f, g=2.5f;
  line("fmul", (int)(f*g*1000.0f));              // 3750
  line("fcmp", (f < g) ? 1 : 0);                 // 1

  // double literal.
  line("pi", (int)(3.14159 * 100000.0));         // 314159

  // a tiny real computation: average of 1..10 as a double = 5.5.
  double sum=0.0; int i;
  for(i=1;i<=10;i++) sum = sum + (double)i;
  line("avg", (int)(sum/10.0*10.0 + 0.5));       // 55

  // variadic int and double arguments.
  line("vari", vsumi(4, 10, 20, 30, 42));                  // 102
  line("vard", (int)(vsumd(3, 1.5, 2.25, 0.25) * 100.0)); // 400

  // float/double round trips through negation and comparison.
  double n = -2.5;
  line("neg", (int)(-n * 10.0));                 // 25

  return 0;
}
`;

const EXPECT = [
  'div3500000',
  'd6_23',
  'd7_2350',
  'fmul3750',
  'fcmp1',
  'pi314159',
  'avg55',
  'vari102',
  'vard400',
  'neg25',
];

test('guest cc compiles and runs floating-point and variadic-double programs', () => {
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  const fs = installFs(disk);
  installChibiccToolchain(fs);
  fs.writeFile('/float.c', new TextEncoder().encode(`${PRELUDE}\n${PROG}\n`));

  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
  });
  machine.keyboard.feed('cc -o /float /float.c\n/float\necho ===ALLDONE===\n');
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  const result = machine.run(8_000_000_000);
  assert.equal(result.reason, 'halt', `VM stopped with ${result.reason}; output:\n${out}`);
  assert.ok(out.includes('===ALLDONE===\n'), `program did not finish; output:\n${out}`);
  assert.equal(out.includes('cc:'), false, `guest cc reported an error:\n${out}`);
  assert.equal(out.includes('PANIC'), false, `kernel panicked:\n${out}`);

  for (const want of EXPECT) {
    assert.ok(out.includes(want), `missing expected line "${want}"\n--- full output ---\n${out}`);
  }
});
