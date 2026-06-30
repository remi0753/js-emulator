// Turn the raw program counters from a guest `cc` crash into a readable call
// chain. When the guest kernel kills a faulting process it prints, e.g.:
//
//   kernel: SIGSEGV pid=2 addr=8 pc=67491248 err=5
//   kernel: backtrace (decimal pcs; symbolize with tools/symbolize-guest-cc.ts):
//     67491248 67492016 67501880 ...
//
// Those pcs are absolute guest addresses into /bin/cc. This tool maps each to the
// nearest compiler symbol so you see `gen_float_value (+975)` instead of a number.
//
// Usage:
//   node tools/symbolize-guest-cc.ts 67491248 67492016 ...   # explicit pcs
//   node tools/symbolize-guest-cc.ts 0x405d5b0               # hex works too
//   pbpaste | node tools/symbolize-guest-cc.ts               # paste the kernel log
//
// With no arguments it reads stdin and pulls every plausible code address out of
// whatever you paste (so you can pipe the kernel lines straight in).

import { chibiccCompilerSymbols } from '../src/v3/guest-chibicc.ts';
import { GUEST_KERNEL_LAYOUT } from '../src/v3/guest-kernel.ts';

const USER_BASE = GUEST_KERNEL_LAYOUT.userLoadBase;

const symbols = [...chibiccCompilerSymbols(true)]
  .filter(([name]) => !name.startsWith('.L'))
  .sort((a, b) => a[1] - b[1]);

// Nearest symbol at or below `pc`, with the byte offset into it.
function symbolAt(pc: number): { name: string; offset: number } {
  let lo = 0;
  let hi = symbols.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (symbols[mid]![1] <= pc) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return { name: '<below image>', offset: pc };
  const [name, addr] = symbols[best]!;
  return { name, offset: pc - addr };
}

function parsePc(token: string): number | undefined {
  const value =
    token.startsWith('0x') || token.startsWith('0X')
      ? Number.parseInt(token, 16)
      : Number.parseInt(token, 10);
  return Number.isFinite(value) ? value : undefined;
}

async function collectPcs(): Promise<number[]> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    return args.map(parsePc).filter((n): n is number => n !== undefined);
  }
  // No args: read stdin and extract every number that looks like a code address.
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const pcs: number[] = [];
  for (const token of text.split(/[^0-9a-fA-Fx]+/)) {
    const value = parsePc(token);
    // Only keep words that fall in the user window — skips pid/err/addr=8 noise.
    if (value !== undefined && value >= USER_BASE && value < USER_BASE + 0x4000000) {
      pcs.push(value);
    }
  }
  return pcs;
}

const pcs = await collectPcs();
if (pcs.length === 0) {
  console.error('no program counters given. Pass pcs as args, or pipe the kernel log on stdin.');
  process.exit(1);
}

for (let i = 0; i < pcs.length; i++) {
  const pc = pcs[i]!;
  const { name, offset } = symbolAt(pc);
  // A return address lands a small way into a function; a large offset usually
  // means the word was a stray data/stack pointer the heuristic scan picked up.
  const suspect = offset > 4096 ? '  (?, likely not a frame)' : '';
  const frame = `#${i}`.padEnd(4);
  console.log(`${frame} 0x${pc.toString(16).padStart(8, '0')}  ${name} (+${offset})${suspect}`);
}
