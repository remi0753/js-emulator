// Compile and run REAL zlib inside the guest.
//
// This is the package-queue milestone (docs/phase35-package-queue.md #2): the
// guest-native C toolchain compiles unmodified, third-party zlib v1.3.1 source
// (vendored byte-for-byte in test/fixtures/zlib) entirely inside the emulated
// OS -- each translation unit with `cc -c`, then linked with `cc -o` -- and runs
// a compress()/uncompress() round trip whose result is checked for correctness.
//
// The build is driven from an on-disk script via `sh /build.sh` rather than a
// long keyboard feed: a multi-minute compile would otherwise overflow the tty
// input buffer. The only adjustment to the vendored source is prepending
// `#define DYNAMIC_CRC_TABLE` to crc32.c at stage time, so the CRC tables are
// computed at runtime instead of pulling in the ~9400-line static crc32.h.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

const ZLIB_DIR = fileURLToPath(new URL('./fixtures/zlib', import.meta.url));

// zlib translation units needed for the compress()/uncompress() round trip,
// plus the harness; compiled in this order and linked together.
const UNITS = [
  'adler32',
  'crc32',
  'deflate',
  'inffast',
  'inflate',
  'inftrees',
  'trees',
  'zutil',
  'compress',
  'uncompr',
  'ztest',
];

// Harness: a freestanding bump allocator (zlib's default zcalloc/zcfree call
// malloc/free) and memcmp (not in the crt), then a compress -> uncompress round
// trip over a compressible 4 KiB buffer, printing the real zlib version, return
// codes, sizes, and whether the decompressed bytes match the original.
const HARNESS = String.raw`#include "zlib.h"
extern int write(int fd, char *buf, int n);
static char arena[2*1024*1024];
static int arena_off=0;
void *malloc(int n){ n=(n+7)&~7; if(arena_off+n>(int)sizeof(arena)) return (void*)0; void*p=&arena[arena_off]; arena_off+=n; return p; }
void free(void *p){ (void)p; }
void *calloc(int c,int s){ int n=c*s; char*p=(char*)malloc(n); if(p){int i;for(i=0;i<n;i++)p[i]=0;} return p; }
int memcmp(void *a,void *b,int n){ unsigned char*x=(unsigned char*)a,*y=(unsigned char*)b; int i; for(i=0;i<n;i++){ if(x[i]!=y[i]) return (int)x[i]-(int)y[i]; } return 0; }
int slen(char*s){int n=0;while(s[n])n++;return n;}
void puts2(char*s){write(1,s,slen(s));}
void putint(int n){char b[16];int i=15;unsigned u;b[i]=0;if(n<0){write(1,"-",1);u=(unsigned)(-n);}else u=(unsigned)n;if(u==0){i--;b[i]='0';}while(u>0){i--;b[i]=(char)('0'+u%10);u/=10;}write(1,b+i,15-i);}
#define N 4096
static unsigned char src[N];
static unsigned char comp[8192];
static unsigned char dec[N];
int main(void){
  int i; char *pat="zlib_on_custom32!";
  for(i=0;i<N;i++) src[i]=(unsigned char)pat[i%17];
  unsigned long srclen=N, complen=sizeof(comp), declen=sizeof(dec);
  int rc=compress(comp,&complen,src,srclen);
  int rc2=uncompress(dec,&declen,comp,complen);
  int ok=(rc==0 && rc2==0 && (int)declen==N && memcmp(dec,src,N)==0);
  puts2("zlib v"); puts2((char*)zlibVersion());
  puts2(" rc="); putint(rc); puts2(","); putint(rc2);
  puts2(" in="); putint((int)srclen); puts2(" out="); putint((int)complen);
  puts2(" roundtrip="); putint(ok); puts2("\n");
  return 0;
}
`;

test('guest cc compiles and runs real zlib v1.3.1 (compress/uncompress round trip)', () => {
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  const fs = installFs(disk);
  installChibiccToolchain(fs);

  const enc = new TextEncoder();
  for (const f of readdirSync(ZLIB_DIR)) {
    if (!/\.[ch]$/.test(f)) continue; // source/headers only (skip PROVENANCE.md)
    let text = readFileSync(`${ZLIB_DIR}/${f}`, 'utf8');
    if (f === 'crc32.c') text = `#define DYNAMIC_CRC_TABLE\n${text}`;
    fs.writeFile(`/usr/src/zlib/${f}`, enc.encode(text));
  }
  fs.writeFile('/usr/src/zlib/ztest.c', enc.encode(HARNESS));
  fs.writeFile(
    '/usr/src/zlib/link.objs',
    enc.encode(`${UNITS.map((u) => `/b/${u}.o`).join('\n')}\n`),
  );

  const script = ['mkdir /b'];
  for (const u of UNITS) {
    script.push(`echo CC ${u}`);
    script.push(`cc -c -I/usr/src/zlib -o /b/${u}.o /usr/src/zlib/${u}.c`);
  }
  script.push('echo LINK', 'cc -o /ztest @/usr/src/zlib/link.objs', 'echo RUN', '/ztest', '');
  fs.writeFile('/build.sh', enc.encode(script.join('\n')));

  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
  });
  machine.keyboard.feed('sh /build.sh\n');
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  // Compiling ~11 real zlib units in the guest is heavy (~30B instructions);
  // this ceiling is generous, the run halts well under it.
  const result = machine.run(120_000_000_000);
  assert.equal(result.reason, 'halt', `VM stopped with ${result.reason}; output:\n${out}`);
  assert.equal(out.includes('cc:'), false, `guest cc reported an error:\n${out}`);
  assert.equal(out.includes('PANIC'), false, `kernel panicked:\n${out}`);

  // Real zlib identified itself and the round trip verified.
  assert.ok(out.includes('zlib v1.3.1'), `zlib did not run; output:\n${out}`);
  assert.ok(out.includes('roundtrip=1'), `compress/uncompress round trip failed:\n${out}`);
  // It actually compressed (the repetitive input collapses well under 4096).
  const m = out.match(/out=(\d+)/);
  assert.ok(m && Number(m[1]) > 0 && Number(m[1]) < 4096, `unexpected compressed size:\n${out}`);
});
