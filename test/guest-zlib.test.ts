// Compile and run REAL zlib inside the guest.
//
// This is the package-queue milestone (docs/phase35-package-queue.md #2): the
// guest-native C toolchain compiles unmodified, third-party zlib v1.3.1 source
// (vendored byte-for-byte in test/fixtures/zlib) entirely inside the emulated
// OS -- each translation unit with `cc -c`, then linked with `cc -o` -- and runs
// a compress()/uncompress() round trip whose result is checked for correctness.
//
// The 11 translation units are independent (`cc -c`), so they are compiled in
// PARALLEL: each unit is built in its own guest VM on a worker thread, the
// resulting `.o` is read back off that guest's disk, and the main thread links
// the collected objects in one final guest and runs the round trip. This keeps
// the full compile-every-run fidelity (real zlib, real guest cc, every unit) but
// spreads the ~30B-instruction compile across cores instead of one serial VM.
//
// This file doubles as the worker: when loaded off the main thread it compiles
// the single unit named in `workerData` and posts the object bytes back. The
// only adjustment to the vendored source is prepending `#define
// DYNAMIC_CRC_TABLE` to crc32.c at stage time, so the CRC tables are computed at
// runtime instead of pulling in the ~9400-line static crc32.h.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

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

// How many guests to compile in parallel. Each lane is a CPU-bound worker, so
// the useful ceiling is the number of *fast* cores: on Apple-silicon (and other
// asymmetric) Macs, availableParallelism() counts the slow efficiency cores too,
// and a compile batch landing on one drags the whole makespan -- capping at the
// performance-core count (hw.perflevel0) measured fastest. Falls back to
// availableParallelism() elsewhere; override with ZLIB_LANES for tuning.
function laneCount(units: number): number {
  if (process.env.ZLIB_LANES) return Math.max(1, Math.min(Number(process.env.ZLIB_LANES), units));
  let cores = availableParallelism();
  if (process.platform === 'darwin') {
    try {
      const perf = Number(
        execFileSync('sysctl', ['-n', 'hw.perflevel0.logicalcpu'], { encoding: 'utf8' }).trim(),
      );
      if (Number.isFinite(perf) && perf > 0) cores = perf;
    } catch {
      // no perflevel info -- keep availableParallelism()
    }
  }
  return Math.min(cores, units);
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

const ZLIB_DIR = fileURLToPath(new URL('./fixtures/zlib', import.meta.url));

// zlib translation units needed for the compress()/uncompress() round trip,
// plus the harness; linked in this order. (Compile order is independent and is
// chosen separately for scheduling.)
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

// Stage the vendored zlib sources + the harness into a freshly-installed guest
// so any unit can be compiled (every `.c` may #include any of the headers).
function stageSources(fs: Fs): void {
  const enc = new TextEncoder();
  for (const f of readdirSync(ZLIB_DIR)) {
    if (!/\.[ch]$/.test(f)) continue; // source/headers only (skip PROVENANCE.md)
    let text = readFileSync(`${ZLIB_DIR}/${f}`, 'utf8');
    if (f === 'crc32.c') text = `#define DYNAMIC_CRC_TABLE\n${text}`;
    fs.writeFile(`/usr/src/zlib/${f}`, enc.encode(text));
  }
  fs.writeFile('/usr/src/zlib/ztest.c', enc.encode(HARNESS));
}

// Compile a batch of units in ONE guest VM and return their object bytes. A
// fresh guest boot costs ~28s (booting + paging the cc binary in cold), so the
// units are batched per worker: that fixed cost is paid once per boot and the cc
// binary stays warm in the page cache across the batch's compiles, rather than
// being re-paid per unit. Driven from an on-disk script via `sh /build.sh`; the
// objects are read back off the guest disk after the VM halts on shell EOF. Runs
// on a worker thread.
function compileBatch(units: string[]): Array<[string, Uint8Array]> {
  const enc = new TextEncoder();
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  const fs = installFs(disk);
  installChibiccToolchain(fs);
  stageSources(fs);
  const script = ['mkdir /b'];
  for (const u of units) script.push(`cc -c -I/usr/src/zlib -o /b/${u}.o /usr/src/zlib/${u}.c`);
  script.push('echo __CCDONE__', '');
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

  // A batch of real zlib units is heavy; this ceiling is generous (the run halts
  // well under it once the shell hits EOF after the script).
  const label = units.join(',');
  const result = machine.run(120_000_000_000);
  if (result.reason !== 'halt')
    throw new Error(`batch ${label}: VM stopped with ${result.reason}\n${out}`);
  if (out.includes('cc:')) throw new Error(`batch ${label}: guest cc reported an error\n${out}`);
  if (out.includes('PANIC')) throw new Error(`batch ${label}: kernel panicked\n${out}`);
  if (!out.includes('__CCDONE__'))
    throw new Error(`batch ${label}: compile did not finish\n${out}`);

  // Re-mount fresh: the guest created /b/<unit>.o through its own FS, so the
  // host Fs used to stage sources has no record of it; a fresh mount reads the
  // write-through state from the disk image the VM just mutated.
  const out_fs = installFs(disk);
  return units.map((u) => {
    const inum = out_fs.namei(`/b/${u}.o`);
    if (!inum) throw new Error(`batch ${label}: no object produced for ${u}\n${out}`);
    return [u, out_fs.readFile(inum)];
  });
}

// --- worker entry: compile the requested batch and post the objects back ---
if (!isMainThread) {
  parentPort?.postMessage(compileBatch(workerData.units as string[]));
}

function compileBatchInWorker(units: string[]): Promise<Array<[string, Uint8Array]>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { units } });
    worker.once('message', (objects: Array<[string, Uint8Array]>) => {
      resolve(objects);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
}

if (isMainThread) {
  test('guest cc compiles and runs real zlib v1.3.1 (compress/uncompress round trip)', async () => {
    // Bin-pack the units into one batch per worker (~compile cost ∝ source
    // size), greedily assigning the largest unit to the lightest bin. Compile
    // cost is dominated by the ~28s fixed boot, so this balances each worker's
    // total work and keeps the makespan near the heaviest single unit (deflate)
    // plus one boot, instead of one boot per unit.
    const sizeOf = (u: string) =>
      u === 'ztest' ? HARNESS.length : readFileSync(`${ZLIB_DIR}/${u}.c`).length;
    const lanes = laneCount(UNITS.length);
    const bins: string[][] = Array.from({ length: lanes }, () => []);
    const weights = new Array(lanes).fill(0);
    for (const u of [...UNITS].sort((a, b) => sizeOf(b) - sizeOf(a))) {
      let k = 0;
      for (let i = 1; i < lanes; i++) if (weights[i] < weights[k]) k = i;
      (bins[k] as string[]).push(u);
      weights[k] += sizeOf(u);
    }
    // Within a bin, compile cheapest-first so the small unit absorbs the cold
    // page-cache penalty and the big units run with cc already warm.
    for (const b of bins) b.sort((a, c) => sizeOf(a) - sizeOf(c));

    const objects = new Map<string, Uint8Array>();
    const results = await Promise.all(bins.filter((b) => b.length > 0).map(compileBatchInWorker));
    for (const batch of results) for (const [u, bytes] of batch) objects.set(u, bytes);

    // Link the collected objects (in canonical order) and run the round trip in
    // one final guest.
    const enc = new TextEncoder();
    const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
    const fs = installFs(disk);
    installChibiccToolchain(fs);
    fs.mkdirp('/b');
    for (const u of UNITS) fs.writeFile(`/b/${u}.o`, objects.get(u)!);
    fs.writeFile('/b/link.objs', enc.encode(`${UNITS.map((u) => `/b/${u}.o`).join('\n')}\n`));
    fs.writeFile(
      '/build.sh',
      enc.encode(['echo LINK', 'cc -o /ztest @/b/link.objs', 'echo RUN', '/ztest', ''].join('\n')),
    );

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
}
