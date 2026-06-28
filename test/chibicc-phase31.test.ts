import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import { crt0Object } from '../src/toolchain/cc.ts';
import { compile, compileObject } from '../src/toolchain/chibicc/index.ts';
import { linkObjects } from '../src/toolchain/object-linker.ts';
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

// Phase 31 done criterion: a host-built custom32 C compiler compiles
// `int main(void) { return 42; }`, the result assembles and links, runs in the
// guest, and the observed exit status is 42.
const RET42_SRC = 'int main(void) { return 42; }';

// A launcher exercising the whole backend slice: globals (`argv`), char arrays,
// pointer indexing, while/if, the arithmetic/bitwise/shift operators, function
// calls, string literals, and the `__syscall` intrinsic. It forks/execs
// /bin/ret42, waits, decodes the child status (status = code << 8), and prints
// it — so the console output proves the exit status the guest reported.
const LAUNCH_SRC = `
char *argv[2];

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
  int pid = __syscall(4, 0, 0, 0);
  if (pid == 0) {
    argv[0] = "/bin/ret42";
    argv[1] = 0;
    __syscall(5, "/bin/ret42", argv, 0);
    __syscall(0, 1, 0, 0);
  }
  int status;
  __syscall(6, &status, 0, 0);
  int code = (status >> 8) & 255;
  puts("ret42 exited ");
  putnum(code);
  puts("\\n");
  return 0;
}
`;

const EXPECTED = 'ret42 exited 42\n';

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

// Boot a disk image, run `command` from the shell, return the captured console.
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

// --- frontend / backend unit tests -----------------------------------------

test('chibicc compiles the canonical return-42 program', () => {
  const asm = compile(RET42_SRC);
  assert.match(asm, /\.global main/);
  assert.match(asm, /MOV R0, 42/);
  assert.match(asm, /RET/);
});

test('chibicc decodes control-character escapes to their ASCII values', () => {
  // Regression: \v, \f, \a, \b were passed through as the literal letter, so
  // '\v' became 'v' (118) instead of 11. That corrupted the guest libc, whose
  // isspace() compares against '\v'/'\f', making the C tokenizer treat 'v'/'f'
  // as whitespace and skip the leading letter of e.g. `void *p;`.
  assert.match(compile("int main(void) { return '\\a'; }"), /MOV R0, 7\b/);
  assert.match(compile("int main(void) { return '\\b'; }"), /MOV R0, 8\b/);
  assert.match(compile("int main(void) { return '\\v'; }"), /MOV R0, 11\b/);
  assert.match(compile("int main(void) { return '\\f'; }"), /MOV R0, 12\b/);
  // Existing escapes keep their values.
  assert.match(compile("int main(void) { return '\\n'; }"), /MOV R0, 10\b/);
  assert.match(compile("int main(void) { return '\\t'; }"), /MOV R0, 9\b/);
});

test('chibicc lowers a unit into an object with the right symbols', () => {
  const obj = compileObject('int g = 5;\nint add(int a, int b) { return a + b; }', {
    name: 'unit.o',
  });
  const byName = new Map(obj.symbols.map((s) => [s.name, s]));
  // Defined function and global are exported; the shared stack pointer is an
  // undefined reference resolved from crt0, exactly like the bootstrap object.
  assert.equal(byName.get('add')?.binding, 'global');
  assert.equal(byName.get('add')?.section, 'text');
  assert.equal(byName.get('g')?.binding, 'global');
  assert.equal(byName.get('g')?.section, 'data');
  assert.equal(byName.get('__csp')?.section, 'undef');
  // No startup is emitted into a translation unit.
  assert.ok(!obj.symbols.some((s) => s.name === '_start' && s.section !== 'undef'));
});

test('chibicc objects link against the bootstrap crt0', () => {
  const a = compileObject('int helper(int x) { return x + 1; }', { name: 'a.o' });
  const b = compileObject('extern int helper(int x);\nint main(void) { return helper(2); }', {
    name: 'b.o',
  });
  const linked = linkObjects([crt0Object(), a, b], [], {
    entry: '_start',
    textOrigin: GUEST_KERNEL_LAYOUT.userLoadBase,
  });
  assert.ok(linked.symbols.has('helper'));
  assert.ok(linked.symbols.has('main'));
});

test('chibicc reports diagnostics for malformed input', () => {
  assert.throws(() => compile('int main(void) { return 1 }'), /parse error/);
  assert.throws(() => compile('int main(void) { return x; }'), /undefined variable/);
});

// --- end-to-end: the Phase 31 done criterion --------------------------------

test('chibicc-built program runs in the guest with exit status 42', () => {
  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/ret42', linkProgram(RET42_SRC, 'ret42.o'));
  fs.chmod('/bin/ret42', 0o755);
  fs.writeFile('/bin/launch', linkProgram(LAUNCH_SRC, 'launch.o'));
  fs.chmod('/bin/launch', 0o755);

  const out = bootAndRun(disk, 'launch');
  assert.ok(out.includes(EXPECTED), `missing '${EXPECTED.trim()}' in:\n${out}`);
});

// --- the host CLI (custom32-cc --frontend chibicc) --------------------------

test('custom32-cc --frontend chibicc compiles, links, and installs', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'chibicc-'));
  const run = (tool: string, args: string[]) => {
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', join(root, 'tools', tool), ...args],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `${tool} failed: ${r.stderr}`);
    return r.stdout;
  };

  writeFileSync(join(dir, 'ret42.c'), RET42_SRC);
  writeFileSync(join(dir, 'launch.c'), LAUNCH_SRC);

  run('mkimg.ts', [join(dir, 'disk.img')]);
  run('custom32-cc.ts', [
    '--frontend',
    'chibicc',
    '-o',
    join(dir, 'ret42'),
    join(dir, 'ret42.c'),
    '--install',
    join(dir, 'disk.img'),
    '--install-as',
    '/bin/ret42',
  ]);
  run('custom32-cc.ts', [
    '--frontend',
    'chibicc',
    '-o',
    join(dir, 'launch'),
    join(dir, 'launch.c'),
    '--install',
    join(dir, 'disk.img'),
    '--install-as',
    '/bin/launch',
  ]);

  // The CLI-built executable matches the in-process pipeline byte for byte.
  const cliRet42 = new Uint8Array(readFileSync(join(dir, 'ret42')));
  assert.deepEqual([...cliRet42], [...linkProgram(RET42_SRC, 'ret42.c')]);

  const disk = new Uint8Array(readFileSync(join(dir, 'disk.img')));
  const out = bootAndRun(disk, 'launch');
  assert.ok(out.includes(EXPECTED), `missing '${EXPECTED.trim()}' in:\n${out}`);
});
