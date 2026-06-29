import { DirectBlockDevice } from '../src/storage/direct-block-device.ts';
import { Fs } from '../src/storage/fs.ts';
import { bootGuestDiskImage } from '../src/v3/boot.ts';
import { chibiccCompilerSymbols, installChibiccToolchain } from '../src/v3/guest-chibicc.ts';
import { buildGuestDiskImage, GUEST_DEVELOPMENT_FS_BLOCKS } from '../src/v3/guest-kernel.ts';
import type { Mnemonic } from '../src/isa.ts';

const BUDGET = Number(process.env.GUEST_CC_BUDGET ?? 20_000_000_000);
const SAMPLE_EVERY = Number(process.env.GUEST_CC_SAMPLE_EVERY ?? 16384);
const TRACE = process.env.GUEST_CC_TRACE !== '0';
const MODE = process.argv[2] ?? 'small';

const SOURCES: Record<string, string> = {
  small: `
extern int write(int fd, char *buf, int n);
int slen(char *s){int n=0;while(s[n])n++;return n;}
void puts2(char *s){write(1,s,slen(s));}
int fib(int n){if(n<2)return n;return fib(n-1)+fib(n-2);}
int main(void){puts2("fib\\n");return fib(8);}
`,
  sha: `
extern int write(int fd, char *buf, int n);
typedef unsigned int u32;
int slen(char *s){int n=0;while(s[n])n++;return n;}
void puts2(char *s){write(1,s,slen(s));}
u32 ror(u32 x,int k){ return (x>>k)|(x<<(32-k)); }
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
  puts2("sha\\n");
  return (int)w[63];
}
`,
};

if (!SOURCES[MODE]) {
  throw new Error(`usage: node tools/profile-guest-cc.ts [${Object.keys(SOURCES).join('|')}]`);
}

function mount(disk: Uint8Array): Fs {
  const fs = new Fs(new DirectBlockDevice(disk));
  fs.mount();
  return fs;
}

function fileSize(fs: Fs, path: string): number {
  const inum = fs.namei(path);
  return inum ? fs.readFile(inum).length : 0;
}

const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
const fs = mount(disk);
installChibiccToolchain(fs);
fs.writeFile('/bench.c', new TextEncoder().encode(SOURCES[MODE]));

const symbols = [...chibiccCompilerSymbols(true)]
  .filter(([name]) => !name.startsWith('.L'))
  .sort((a, b) => a[1] - b[1]);

function symbolAt(pc: number): string {
  let lo = 0;
  let hi = symbols.length - 1;
  let best = '<unknown>';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [name, addr] = symbols[mid]!;
    if (addr <= pc) {
      best = name;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

let out = '';
const { machine } = bootGuestDiskImage(disk, { consoleSink: (s) => (out += s) });
machine.keyboard.feed('cc -S -o /bench.s /bench.c\necho PROFILE_DONE\n');
machine.keyboard.close();

let instructions = 0;
const byMnemonic = new Map<Mnemonic, number>();
const bySymbol = new Map<string, number>();
const recent: { pc: number; mnemonic: Mnemonic; mode: number; symbol: string }[] = [];
if (TRACE) {
  machine.cpu.onTrace = (pc, mnemonic) => {
    instructions++;
    byMnemonic.set(mnemonic, (byMnemonic.get(mnemonic) ?? 0) + 1);
    recent.push({ pc: pc >>> 0, mnemonic, mode: machine.cpu.mode, symbol: symbolAt(pc >>> 0) });
    if (recent.length > 256) recent.shift();
    if (instructions % SAMPLE_EVERY === 0) {
      const sym = symbolAt(pc >>> 0);
      bySymbol.set(sym, (bySymbol.get(sym) ?? 0) + 1);
    }
  };
}

const start = performance.now();
const result = machine.run(BUDGET);
const elapsed = performance.now() - start;

const mounted = mount(disk);
const asmBytes = fileSize(mounted, '/bench.s');

function top<T>(map: Map<T, number>, n: number): [T, number][] {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, n);
}

console.log(`mode=${MODE}`);
console.log(`result=${result.reason}`);
console.log(`elapsed_ms=${elapsed.toFixed(1)}`);
if (TRACE) {
  console.log(`instructions=${instructions}`);
  console.log(`mips=${(instructions / elapsed / 1000).toFixed(3)}`);
}
console.log(`asm_bytes=${asmBytes}`);
if (TRACE) {
  console.log('top_mnemonics=');
  for (const [name, count] of top(byMnemonic, 20)) console.log(`  ${name} ${count}`);
  console.log('top_symbols_sampled=');
  for (const [name, count] of top(bySymbol, 30)) console.log(`  ${name} ${count}`);
}
if (result.reason !== 'halt' || !out.includes('PROFILE_DONE')) {
  console.log('recent_instructions=');
  for (const item of recent.slice(-96)) {
    console.log(`  m${item.mode} 0x${item.pc.toString(16)} ${item.mnemonic} ${item.symbol}`);
  }
}
console.log('guest_tail=');
console.log(out.slice(-1000));
