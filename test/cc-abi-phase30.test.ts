import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { encodeArchive, parseArchive } from '../src/formats/archive.ts';
import { encodeObject } from '../src/formats/object.ts';
import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import { compileObject, crt0Object } from '../src/toolchain/cc.ts';
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

// --- ABI smoke programs ----------------------------------------------------
//
// A tiny libc (compiled C, then archived) exercises "libc calls" and archive
// member-on-demand search. The numbers are the raw guest syscall ABI the guest
// kernel delivers via INT 0x80 (see src/abi.ts): exit=0, write=1, fork=4,
// exec=5, wait=6.

const LIBC_SRC = `
int write(int fd, char *buf, int n) { return __syscall(1, fd, buf, n); }
int sys_fork(void) { return __syscall(4, 0, 0, 0); }
int sys_exec(char *path, char **argv, char **envp) { return __syscall(5, path, argv, envp); }
int sys_wait(int *status) { return __syscall(6, status, 0, 0); }
int sys_exit(int code) { return __syscall(0, code, 0, 0); }
int slen(char *s) { int n = 0; while (s[n]) { n = n + 1; } return n; }
int puts2(char *s) { return write(1, s, slen(s)); }
int putnum(int v) {
  char buf[12];
  int i = 11;
  buf[11] = 0;
  if (v == 0) { char z[2]; z[0] = '0'; z[1] = 0; return puts2(z); }
  while (v > 0) { i = i - 1; buf[i] = 48 + (v % 10); v = v / 10; }
  return puts2(buf + i);
}
`;

// helpers.o: globals, arrays, and a struct-pointer argument across the ABI.
const HELPERS_SRC = `
struct Point { int x; int y; };
int gtotal = 100;
int sum_array(int *a, int n) {
  int s = 0;
  int i = 0;
  while (i < n) { s = s + a[i]; i = i + 1; }
  return s;
}
int point_delta(struct Point *p) { return p->y - p->x; }
`;

// abimain.o: calls helpers + libc, builds argv/envp, forks/execs the child,
// waits, and decodes the child's exit status (status = code << 8).
const MAIN_SRC = `
struct Point { int x; int y; };
extern int puts2(char *s);
extern int putnum(int v);
extern int sys_fork(void);
extern int sys_exec(char *path, char **argv, char **envp);
extern int sys_wait(int *status);
extern int sys_exit(int code);
extern int sum_array(int *a, int n);
extern int point_delta(struct Point *p);
extern int gtotal;

char *child_argv[2];
char *child_envp[2];

int compute(void) {
  int arr[4];
  arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4;
  struct Point p;
  p.x = 10; p.y = 17;
  return sum_array(arr, 4) + point_delta(&p) + gtotal;
}

int main(int argc, char **argv) {
  puts2("compute=");
  putnum(compute());
  puts2("\n");
  int pid = sys_fork();
  if (pid == 0) {
    child_argv[0] = "/bin/abichild";
    child_argv[1] = 0;
    child_envp[0] = "ABI=ok";
    child_envp[1] = 0;
    sys_exec("/bin/abichild", child_argv, child_envp);
    sys_exit(1);
  }
  int status;
  sys_wait(&status);
  int code = (status >> 8) & 255;
  puts2("child exited ");
  putnum(code);
  puts2("\n");
  return 0;
}
`;

// abichild.o: prints argv[0] and environ[0] (startup ABI), exits 7.
const CHILD_SRC = `
extern int puts2(char *s);
extern int sys_exit(int code);
extern char **environ;
int main(int argc, char **argv) {
  puts2("child argv0=");
  puts2(argv[0]);
  puts2(" env=");
  if (environ != 0) { if (environ[0] != 0) { puts2(environ[0]); } else { puts2("(none)"); } }
  else { puts2("(none)"); }
  puts2("\n");
  sys_exit(7);
  return 7;
}
`;

// The expected console output: 1+2+3+4 + (17-10) + 100 = 117, the child's
// argv/envp echoed through startup, and the decoded exit status.
const EXPECTED = 'compute=117\nchild argv0=/bin/abichild env=ABI=ok\nchild exited 7\n';

function buildLibabi(): Uint8Array {
  return encodeArchive({
    members: [{ name: 'libc.o', data: encodeObject(compileObject(LIBC_SRC, { name: 'libc.o' })) }],
  });
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

// Boot a disk image that has /bin/abimain installed, run it from the shell, and
// return the captured console output.
function bootAndRun(disk: Uint8Array): string {
  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
  });
  machine.keyboard.feed('abimain\n');
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });
  const result = machine.run(60_000_000);
  assert.equal(result.reason, 'halt');
  return out;
}

// --- driver / lowering unit tests ------------------------------------------

test('compileObject lowers a C unit into a relocatable object with the right symbols', () => {
  const obj = compileObject('int g = 5;\nint add(int a, int b) { return a + b; }', {
    name: 'unit.o',
  });
  const byName = new Map(obj.symbols.map((s) => [s.name, s]));
  // Defined function and global are exported; the shared stack pointer is an
  // undefined reference resolved from crt0, not a local definition here.
  assert.equal(byName.get('add')?.binding, 'global');
  assert.equal(byName.get('add')?.section, 'text');
  assert.equal(byName.get('g')?.binding, 'global');
  assert.equal(byName.get('g')?.section, 'data');
  assert.equal(byName.get('__csp')?.section, 'undef');
  // No startup is emitted into a translation unit.
  assert.ok(!obj.symbols.some((s) => s.name === '_start' && s.section !== 'undef'));
});

test('crt0 provides startup and runtime symbols exactly once', () => {
  const crt0 = crt0Object();
  const provided = new Set(
    crt0.symbols.filter((s) => s.binding === 'global' && s.section !== 'undef').map((s) => s.name),
  );
  for (const name of ['_start', '__csp', '__stack', 'environ', 'memcpy', 'memset'])
    assert.ok(provided.has(name), `crt0 should provide ${name}`);

  // Two C objects each reference __csp but neither defines it, so linking them
  // with crt0 does not raise a duplicate-symbol error.
  const a = compileObject('int helper(int x) { return x + 1; }', { name: 'a.o', moduleId: 'a' });
  const b = compileObject('extern int helper(int x);\nint main(void) { return helper(2); }', {
    name: 'b.o',
    moduleId: 'b',
  });
  const linked = linkObjects([crt0, a, b], [], {
    entry: '_start',
    textOrigin: GUEST_KERNEL_LAYOUT.userLoadBase,
  });
  assert.ok(linked.symbols.has('helper'));
  assert.ok(linked.symbols.has('main'));
});

test('linking without startup files fails to resolve the entry point', () => {
  const main = compileObject('int main(void) { return 0; }', { name: 'main.o' });
  assert.throws(
    () => linkGuestExecutable([main], [], {}),
    /entry symbol not found|undefined symbol/,
  );
});

// --- end-to-end in-process pipeline ----------------------------------------

test('compiled multi-file C + archive boots, runs, and reports exit status', () => {
  const libabi = parseArchive(buildLibabi());
  const crt0 = crt0Object();

  const mainExe = linkGuestExecutable(
    [
      crt0,
      compileObject(MAIN_SRC, { name: 'main.o', moduleId: 'main' }),
      compileObject(HELPERS_SRC, { name: 'helpers.o', moduleId: 'helpers' }),
    ],
    [libabi],
  );
  const childExe = linkGuestExecutable(
    [crt0Object(), compileObject(CHILD_SRC, { name: 'child.o', moduleId: 'child' })],
    [libabi],
  );

  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/abimain', mainExe);
  fs.chmod('/bin/abimain', 0o755);
  fs.writeFile('/bin/abichild', childExe);
  fs.chmod('/bin/abichild', 0o755);

  const out = bootAndRun(disk);
  assert.ok(out.includes(EXPECTED), `missing expected sequence in:\n${out}`);
});

// --- the custom32-cc host driver CLI ---------------------------------------

test('custom32-cc compiles, archives, links, and installs from the command line', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'custom32-cc-'));
  const run = (tool: string, args: string[]) => {
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', join(root, 'tools', tool), ...args],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `${tool} failed: ${r.stderr}`);
    return r.stdout;
  };

  writeFileSync(join(dir, 'libc.c'), LIBC_SRC);
  writeFileSync(join(dir, 'helpers.c'), HELPERS_SRC);
  writeFileSync(join(dir, 'abimain.c'), MAIN_SRC);
  writeFileSync(join(dir, 'abichild.c'), CHILD_SRC);

  // Compile the libc to an object and archive it.
  run('custom32-cc.ts', ['-c', '-o', join(dir, 'libc.o'), join(dir, 'libc.c')]);
  run('custom32-ar.ts', ['rc', join(dir, 'libabi.a'), join(dir, 'libc.o')]);

  // Build a fresh disk image and install both executables through the driver.
  run('mkimg.ts', [join(dir, 'disk.img')]);
  run('custom32-cc.ts', [
    '-o',
    join(dir, 'abimain'),
    join(dir, 'abimain.c'),
    join(dir, 'helpers.c'),
    '-L',
    dir,
    '-labi',
    '--install',
    join(dir, 'disk.img'),
    '--install-as',
    '/bin/abimain',
  ]);
  run('custom32-cc.ts', [
    '-o',
    join(dir, 'abichild'),
    join(dir, 'abichild.c'),
    '-L',
    dir,
    '-labi',
    '--install',
    join(dir, 'disk.img'),
    '--install-as',
    '/bin/abichild',
  ]);

  // The CLI-built executable matches the in-process pipeline byte for byte.
  const cliMain = new Uint8Array(readFileSync(join(dir, 'abimain')));
  const libMain = linkGuestExecutable(
    [
      crt0Object(),
      compileObject(MAIN_SRC, { name: 'abimain.c', moduleId: 'abimain.c' }),
      compileObject(HELPERS_SRC, { name: 'helpers.c', moduleId: 'helpers.c' }),
    ],
    [parseArchive(buildLibabi())],
  );
  assert.deepEqual([...cliMain], [...libMain]);

  // Boot the CLI-produced image and assert the program's output.
  const disk = new Uint8Array(readFileSync(join(dir, 'disk.img')));
  const out = bootAndRun(disk);
  assert.ok(out.includes(EXPECTED), `missing expected sequence in:\n${out}`);
});
