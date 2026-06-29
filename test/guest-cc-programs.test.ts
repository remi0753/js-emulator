// End-to-end "compile real software in the guest" suite.
//
// The guest `/bin/cc` (the chibicc frontend + custom32 backend running INSIDE the
// emulated OS) compiles a graduated set of self-contained C programs from the
// guest filesystem, links each into a flat executable with the compact guest
// crt/runtime, and runs it — all with no host-side compilation after boot. The
// programs climb from tiny arithmetic up to two recognizable pieces of real
// software (a Brainfuck interpreter and a full SHA-256), and each is checked
// against a known-good result, so a miscompile shows up as a wrong answer rather
// than just a crash.
//
// Constraints the programs respect (the guest `cc -o` runtime, see
// src/toolchain/cc-c/guestlink.c): a single translation unit, integers/pointers
// only (no float/VLA), and only write/read/open/close/exit + memcpy/memset/
// strlen/strcmp as library symbols — everything else is implemented in-program.

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

// Small in-program freestanding helpers prepended to every test program: a write
// wrapper, decimal/hex integer printing, and a string length. They lean only on
// the runtime symbols the guest `cc -o` actually links.
const PRELUDE = `
extern int write(int fd, char *buf, int n);
typedef unsigned int u32;
int slen(char *s){int n=0;while(s[n])n++;return n;}
void puts2(char *s){write(1,s,slen(s));}
void putc2(int c){char b; b=(char)c; write(1,&b,1);}
void putint(int n){
  char buf[16]; int i=15; int neg=0; u32 u;
  buf[i]=0;
  if(n<0){neg=1;u=(u32)(-n);}else u=(u32)n;
  if(u==0){i--;buf[i]='0';}
  while(u>0){i--;buf[i]=(char)('0'+(u%10));u=u/10;}
  if(neg){i--;buf[i]='-';}
  write(1,buf+i,15-i);
}
void puthex32(u32 v){
  char hx[9]; int i; char *d="0123456789abcdef";
  for(i=0;i<8;i++){ hx[7-i]=d[v & 15]; v=v>>4; }
  hx[8]=0; write(1,hx,8);
}
`;

interface Prog {
  name: string;
  src: string;
  expect: string;
}

const PROGS: Prog[] = [
  {
    // tiny: operator precedence, ternary, shifts, signed/unsigned arithmetic.
    name: 'arith',
    expect: 'arith=3 shift=320 tern=9',
    src: `int main(void){
      int a = ((7*9 + 100/4) % 17);
      int b = (5 << 6) ^ (0xff & 0);
      int c = (a > b) ? a : (b > 100 ? 9 : 0);
      puts2("arith="); putint(a);
      puts2(" shift="); putint(b);
      puts2(" tern="); putint(c);
      puts2("\\n");
      return 0;
    }`,
  },
  {
    // small: Sieve of Eratosthenes over a char array; 25 primes below 100.
    name: 'sieve',
    expect: 'primes=25',
    src: `int main(void){
      char s[100]; int i; int j; int count=0;
      for(i=0;i<100;i++) s[i]=1;
      for(i=2;i<100;i++){
        if(s[i]){
          count++;
          for(j=i*2;j<100;j+=i) s[j]=0;
        }
      }
      puts2("primes="); putint(count); puts2("\\n");
      return 0;
    }`,
  },
  {
    // small: recursive quicksort over an int array through a pointer.
    name: 'sort',
    expect: 'sorted=0123456789',
    src: `void qsort_int(int *a,int lo,int hi){
      if(lo>=hi) return;
      int p=a[(lo+hi)/2]; int i=lo; int j=hi;
      while(i<=j){
        while(a[i]<p) i++;
        while(a[j]>p) j--;
        if(i<=j){ int t=a[i]; a[i]=a[j]; a[j]=t; i++; j--; }
      }
      qsort_int(a,lo,j);
      qsort_int(a,i,hi);
    }
    int main(void){
      int a[10]; int i;
      int seed[10]; seed[0]=5;seed[1]=2;seed[2]=8;seed[3]=1;seed[4]=9;
      seed[5]=3;seed[6]=7;seed[7]=4;seed[8]=6;seed[9]=0;
      for(i=0;i<10;i++) a[i]=seed[i];
      qsort_int(a,0,9);
      puts2("sorted=");
      for(i=0;i<10;i++) putc2('0'+a[i]);
      puts2("\\n");
      return 0;
    }`,
  },
  {
    // small: string reverse into a buffer plus a palindrome check.
    name: 'strrev',
    expect: 'rev=relipmoc pal=1',
    src: `int is_pal(char *s){
      int n=slen(s); int i=0; int j=n-1;
      while(i<j){ if(s[i]!=s[j]) return 0; i++; j--; }
      return 1;
    }
    int main(void){
      char s[16]; char *src="compiler"; int n=slen(src); int i;
      for(i=0;i<n;i++) s[i]=src[n-1-i];
      s[n]=0;
      puts2("rev="); puts2(s);
      puts2(" pal="); putint(is_pal("racecar"));
      puts2("\\n");
      return 0;
    }`,
  },
  {
    // medium: a recursive-descent calculator (a tiny real parser) over a global
    // cursor; evaluates 2+3*4-(5-2) = 11 with correct precedence and parens.
    name: 'calc',
    expect: 'calc=11',
    src: `char *cur;
    int expr(void);
    int number(void){
      int v=0;
      while(*cur>='0' && *cur<='9'){ v=v*10+(*cur-'0'); cur++; }
      return v;
    }
    int factor(void){
      if(*cur=='('){ cur++; int v=expr(); if(*cur==')') cur++; return v; }
      return number();
    }
    int term(void){
      int v=factor();
      while(*cur=='*' || *cur=='/'){
        char op=*cur; cur++;
        int r=factor();
        if(op=='*') v=v*r; else v=v/r;
      }
      return v;
    }
    int expr(void){
      int v=term();
      while(*cur=='+' || *cur=='-'){
        char op=*cur; cur++;
        int r=term();
        if(op=='+') v=v+r; else v=v-r;
      }
      return v;
    }
    int main(void){
      cur="2+3*4-(5-2)";
      int v=expr();
      puts2("calc="); putint(v); puts2("\\n");
      return 0;
    }`,
  },
  {
    // medium real software: bit-by-bit CRC-32. 0xcbf43926 is the canonical
    // check value for the ASCII string "123456789".
    name: 'crc32',
    expect: 'crc32=cbf43926',
    src: `int main(void){
      char *msg="123456789"; int n=slen(msg); int i; int j;
      u32 crc=0xffffffff;
      for(i=0;i<n;i++){
        crc=crc ^ (u32)(unsigned char)msg[i];
        for(j=0;j<8;j++){
          if(crc & 1) crc=(crc>>1) ^ 0xedb88320;
          else crc=crc>>1;
        }
      }
      crc=crc ^ 0xffffffff;
      puts2("crc32="); puthex32(crc); puts2("\\n");
      return 0;
    }`,
  },
  {
    // real software: a Brainfuck interpreter (tape, data pointer, bracket
    // matching). The classic Hello-World program prints "Hello World!\\n".
    name: 'brainfuck',
    expect: 'Hello World!',
    src: `int main(void){
      char *prog="++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.";
      char tape[4096]; int i;
      for(i=0;i<4096;i++) tape[i]=0;
      int dp=0; int pc=0; int n=slen(prog);
      while(pc<n){
        char c=prog[pc];
        if(c=='>') dp++;
        else if(c=='<') dp--;
        else if(c=='+') tape[dp]++;
        else if(c=='-') tape[dp]--;
        else if(c=='.') putc2(tape[dp]);
        else if(c=='['){
          if(tape[dp]==0){ int depth=1; while(depth){ pc++; if(prog[pc]=='[') depth++; else if(prog[pc]==']') depth--; } }
        }
        else if(c==']'){
          if(tape[dp]!=0){ int depth=1; while(depth){ pc--; if(prog[pc]==']') depth++; else if(prog[pc]=='[') depth--; } }
        }
        pc++;
      }
      return 0;
    }`,
  },
  {
    // largest / real software: a full one-block SHA-256. Verifies against the
    // published digest of "abc". Exercises a 64-entry constant table and heavy
    // unsigned 32-bit rotate/shift/add/xor with wraparound.
    name: 'sha256',
    expect: 'sha256=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    src: `u32 ror(u32 x,int k){ return (x>>k)|(x<<(32-k)); }
    u32 K[64]={
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
    int main(void){
      unsigned char msg[64]; int i;
      for(i=0;i<64;i++) msg[i]=0;
      msg[0]='a'; msg[1]='b'; msg[2]='c'; msg[3]=0x80; msg[63]=24;
      u32 w[64];
      for(i=0;i<16;i++)
        w[i]=((u32)msg[i*4]<<24)|((u32)msg[i*4+1]<<16)|((u32)msg[i*4+2]<<8)|((u32)msg[i*4+3]);
      for(i=16;i<64;i++){
        u32 s0=ror(w[i-15],7)^ror(w[i-15],18)^(w[i-15]>>3);
        u32 s1=ror(w[i-2],17)^ror(w[i-2],19)^(w[i-2]>>10);
        w[i]=w[i-16]+s0+w[i-7]+s1;
      }
      u32 h0=0x6a09e667; u32 h1=0xbb67ae85; u32 h2=0x3c6ef372; u32 h3=0xa54ff53a;
      u32 h4=0x510e527f; u32 h5=0x9b05688c; u32 h6=0x1f83d9ab; u32 h7=0x5be0cd19;
      u32 a=h0; u32 b=h1; u32 c=h2; u32 d=h3; u32 e=h4; u32 f=h5; u32 g=h6; u32 h=h7;
      for(i=0;i<64;i++){
        u32 S1=ror(e,6)^ror(e,11)^ror(e,25);
        u32 ch=(e&f)^((~e)&g);
        u32 t1=h+S1+ch+K[i]+w[i];
        u32 S0=ror(a,2)^ror(a,13)^ror(a,22);
        u32 maj=(a&b)^(a&c)^(b&c);
        u32 t2=S0+maj;
        h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
      }
      h0=h0+a; h1=h1+b; h2=h2+c; h3=h3+d; h4=h4+e; h5=h5+f; h6=h6+g; h7=h7+h;
      puts2("sha256=");
      puthex32(h0); puthex32(h1); puthex32(h2); puthex32(h3);
      puthex32(h4); puthex32(h5); puthex32(h6); puthex32(h7);
      puts2("\\n");
      return 0;
    }`,
  },
];

test('guest cc compiles and runs a graduated set of real C programs in the guest', () => {
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  const fs = installFs(disk);
  installChibiccToolchain(fs);

  const enc = new TextEncoder();
  const script: string[] = [];
  for (const p of PROGS) {
    fs.writeFile(`/${p.name}.c`, enc.encode(`${PRELUDE}\n${p.src}\n`));
    script.push(`echo ===${p.name}===`);
    script.push(`cc -o /${p.name} /${p.name}.c`);
    script.push(`/${p.name}`);
  }
  script.push('echo ===ALLDONE===');

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

  // Generous instruction budget: the whole batch (8 guest compiles + runs) halts
  // well under this; it is a ceiling, not the expected count.
  const result = machine.run(40_000_000_000);
  assert.equal(result.reason, 'halt', `VM stopped with ${result.reason}; output:\n${out}`);
  assert.ok(out.includes('===ALLDONE===\n'), `batch did not finish; output:\n${out}`);
  assert.equal(out.includes('cc:'), false, `guest cc reported an error:\n${out}`);
  assert.equal(out.includes('PANIC'), false, `kernel panicked:\n${out}`);

  for (const p of PROGS) {
    assert.ok(
      out.includes(p.expect),
      `program "${p.name}" did not produce the expected result "${p.expect}"\n--- full output ---\n${out}`,
    );
  }
});
