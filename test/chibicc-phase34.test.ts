import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import { crt0Object } from '../src/toolchain/cc.ts';
import { compile, compileObject } from '../src/toolchain/chibicc/index.ts';
import { linkGuestExecutable } from '../src/v3/guest-cc.ts';
import {
  buildChibiccCompiler,
  compileChibiccFrontend,
  compileGuestBackend,
  installChibiccToolchain,
} from '../src/v3/guest-chibicc.ts';
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

// Phase 34 frontend gaps: the language features the vendored C-source chibicc
// frontend needs that the bootstrap frontend was missing. Exercised end to end
// so the inferred sizes, comma sequencing, and literal joining all run.
const FEATURES_SRC = `
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

// Array size inferred from the brace list ("T x[] = {...}").
int primes[] = { 2, 3, 5, 7, 11 };
// ...and from a designated list (length is max index + 1).
int sparse[] = { [3] = 9, [1] = 4 };
// ...and a flexible char array from a string literal.
char name[] = "chibicc";

int main(void) {
  int total = 0;

  // Inferred lengths via sizeof.
  total = total + sizeof(primes) / sizeof(primes[0]); // 5
  total = total + sizeof(sparse) / sizeof(sparse[0]); // 4
  total = total + sizeof(name);                       // 8 ("chibicc" + NUL)
  total = total + primes[4] + sparse[3] + name[0];    // 11 + 9 + 'c'(99) = 119

  // Comma operator: left operand evaluated for its effect, value is the right.
  int a = 0;
  int b = (a = 5, a + 3); // a becomes 5, b becomes 8
  total = total + a + b;  // 13

  // Comma operator in a for-loop init and increment.
  int i, j;
  for (i = 0, j = 10; i < 3; i = i + 1, j = j - 1) { total = total + 1; } // +3
  total = total + j; // j ends at 7

  // Adjacent string-literal concatenation.
  char *greet = "he" "ll" "o";
  total = total + slen(greet); // 5

  puts("features=");
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

function bootAndRun(disk: Uint8Array, command: string, budget = 60_000_000): string {
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
  const result = machine.run(budget);
  assert.equal(result.reason, 'halt', `VM stopped with ${result.reason}; output:\n${out}`);
  return out;
}

test('chibicc Phase 34 frontend gaps compile to the expected shapes', () => {
  // Flexible array length inference: storage is sized to the initializer.
  assert.match(compile('int p[] = {2,3,5,7,11}; int n(void){return sizeof(p);}'), /MOV R0, 20/);
  assert.match(compile('char s[] = "chibicc"; int n(void){return sizeof(s);}'), /MOV R0, 8/);
  assert.match(compile('int p[] = {[5]=1}; int n(void){return sizeof(p);}'), /MOV R0, 24/);
  // Comma operator yields its right operand.
  assert.match(compile('int main(void){ return (1, 2, 7); }'), /MOV R0, 7/);
  // Adjacent string literals join into one.
  const joined = compile('char *g(void){ return "ab" "cd"; }');
  assert.match(joined, /\.L\.str\.\d+/);
  assert.equal((joined.match(/\.L\.str\.\d+:/g) ?? []).length, 1);
  // __LINE__ expands to an integer; __FILE__ to a string literal (emitted as the
  // byte encoding of the unit name "unit.c").
  assert.match(compile('int n(void){ return __LINE__; }\n'), /MOV R0, 1/);
  assert.match(
    compile('char *f(void){ return __FILE__; }', { name: 'unit.c' }),
    /\.byte 117,110,105,116,46,99,0/,
  );
});

test('chibicc Phase 34 cross-compiles the full vendored chibicc frontend', () => {
  const objects = compileChibiccFrontend();
  // tokenize, preprocess, parse, type, hashmap, strings, unicode.
  assert.equal(objects.length, 7);
  for (const obj of objects) assert.ok(obj.text.length > 0 || obj.data.length > 0);
});

test('chibicc Phase 34 cross-compiles the custom32 backend (codegen.c)', () => {
  // The local backend ported from codegen.ts cross-compiles to a relocatable
  // object under the bootstrap frontend, alongside the vendored frontend units.
  const backend = compileGuestBackend();
  assert.ok(backend.text.length > 0, 'codegen.c should emit text');
  // It defines the public entry points the driver and frontend expect.
  const symbols = new Set(backend.symbols.map((s) => s.name));
  assert.ok(symbols.has('codegen'), 'codegen.c must export codegen()');
  assert.ok(symbols.has('align_to'), 'codegen.c must export align_to()');
});

test('chibicc Phase 34 links the guest-native compiler driver', () => {
  const cc = buildChibiccCompiler();
  assert.ok(cc.length > 0, 'guest cc executable should not be empty');
});

test('chibicc Phase 34 frontend gaps run in the guest', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/features', linkProgram(FEATURES_SRC, 'features.o'));
  fs.chmod('/bin/features', 0o755);

  const out = bootAndRun(disk, 'features');
  // 5 + 4 + 8 + 119 + 13 + 3 + 7 + 5 = 164
  assert.ok(out.includes('features=164\n'), `missing features result in:\n${out}`);
});

test('chibicc Phase 34 runs guest cc and emits assembly inside the OS', () => {
  const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });
  const fs = installFs(disk);
  installChibiccToolchain(fs);
  fs.writeFile(
    '/ret.c',
    new TextEncoder().encode('int main(void) { int x = 40; return x + 2; }\n'),
  );

  const out = bootAndRun(disk, 'cc -S -o /tmp/ret.s /ret.c\ncat /tmp/ret.s', 300_000_000);
  assert.ok(out.includes('main:\n'), `missing generated main label in:\n${out}`);
  assert.match(out, /  ADD R0, R[17]\n/, `missing generated addition in:\n${out}`);
});
