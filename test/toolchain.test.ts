import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileC } from '../src/toolchain/c.ts';
import { linkExecutable, linkKernelImage } from '../src/toolchain/linker.ts';
import { SEG } from '../src/v2/kernel/exec.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

test('Phase 10: compiles a non-trivial C-like user program to a segmented executable', () => {
  const source = String.raw`
    struct Pair { int a; int b; };

    int total;
    char msg[] = "ok\n";

    int sum(int *xs, int n) {
      int i;
      int s;
      i = 0;
      s = 0;
      while (i < n) {
        s = s + xs[i];
        i = i + 1;
      }
      return s;
    }

    int main(int argc, char **argv) {
      int xs[3];
      struct Pair p;
      xs[0] = 2;
      xs[1] = 3;
      xs[2] = 4;
      p.a = sum(xs, 3);
      p.b = strlen(msg);
      total = p.a + p.b;
      __syscall(1, 1, msg, p.b);
      return total;
    }
  `;

  const linked = linkExecutable([compileC(source)]);

  assert.equal(linked.executable.segments.length, 2);
  assert.equal(linked.executable.segments[0]!.flags, SEG.R | SEG.X);
  assert.equal(linked.executable.segments[1]!.flags, SEG.R | SEG.W);
  assert.notEqual(linked.symbols.get('_start'), undefined);
  assert.notEqual(linked.symbols.get('main'), undefined);
  assert.notEqual(linked.symbols.get('total'), undefined);
  assert.notEqual(linked.sourceMap.get(linked.symbols.get('main')!), undefined);

  let out = '';
  const logs: string[] = [];
  const kernel = new Kernel({ consoleSink: (s) => (out += s), log: (m) => logs.push(m) });
  kernel.spawn('cprog', linked.executable, ['cprog']);
  kernel.run();

  assert.equal(out, 'ok\n');
  assert.equal(kernel.processes.get(1)!.exitCode, 12);
  assert.deepEqual(logs, ['pid 1 (cprog): exit 12']);
});

function runExit(body: string): number {
  const linked = linkExecutable([compileC(`int main(int argc, char **argv){ ${body} }`)]);
  const kernel = new Kernel({ consoleSink: () => {}, log: () => {} });
  kernel.spawn('p', linked.executable, ['p']);
  kernel.run();
  return kernel.processes.get(1)!.exitCode!;
}

test('Phase 10: && / || are correct and short-circuit', () => {
  assert.equal(runExit('return 0 && 5;'), 0);
  assert.equal(runExit('return 3 && 5;'), 1);
  assert.equal(runExit('return 3 && 0;'), 0);
  assert.equal(runExit('return 0 || 0;'), 0);
  assert.equal(runExit('return 5 || 0;'), 1);
  assert.equal(runExit('if (0 && 5) { return 7; } return 42;'), 42);

  // The right operand of `&&` must not be evaluated when the left is false:
  // calling blow() would divide by zero and trap.
  const sc = `
    int blow(int x) { int z; z = 0; return x / z; }
    int main(int a, char **v) { if (0 && blow(1)) { return 7; } return 99; }
  `;
  const linked = linkExecutable([compileC(sc)]);
  const kernel = new Kernel({ consoleSink: () => {}, log: () => {} });
  kernel.spawn('p', linked.executable, ['p']);
  kernel.run();
  assert.equal(kernel.processes.get(1)!.exitCode, 99);
});

test('Phase 10: pointer arithmetic scales by element size', () => {
  assert.equal(runExit('int xs[2]; xs[0]=11; xs[1]=22; int *p; p=xs; return *(p+1);'), 22);
  assert.equal(runExit('char b[3]; b[0]=65; b[1]=66; b[2]=67; char *p; p=b; return *(p+2);'), 67);
  assert.equal(runExit('int xs[5]; int *a; int *b; a=xs; b=xs+3; return b-a;'), 3);
});

test('Phase 10: block scopes resolve shadowed locals independently', () => {
  assert.equal(
    runExit('int r; r=0; { int x; x=10; r=r+x; } { int x; x=99; r=r+x; } return r;'),
    109,
  );
  assert.equal(runExit('int x; x=1; { int x; x=2; { int x; x=3; } } return x;'), 1);
  assert.equal(runExit('int s; s=0; for (int i=0;i<4;i=i+1){ s=s+i; } return s;'), 6);
});

test('Phase 10: pointer globals initialized from string / address relocate', () => {
  const source = String.raw`
    char buf[] = "XY\n";
    char *greeting = "hi\n";
    char *alias = buf;
    int main(int a, char **v) {
      __syscall(1, 1, greeting, 3);
      __syscall(1, 1, alias, 3);
      return 0;
    }
  `;
  let out = '';
  const linked = linkExecutable([compileC(source)]);
  const kernel = new Kernel({ consoleSink: (s) => (out += s), log: () => {} });
  kernel.spawn('p', linked.executable, ['p']);
  kernel.run();
  assert.equal(out, 'hi\nXY\n');
});

test('Phase 10: links multiple objects with shared runtime/crt0', () => {
  const objA = compileC(`int helper(int x); int main(int a, char **v){ return helper(20) + 1; }`, {
    start: 'user',
  });
  const objB = compileC(`int helper(int x){ int t; t = x; return t * 2; }`, { start: 'none' });
  const linked = linkExecutable([objA, objB]);
  const kernel = new Kernel({ consoleSink: () => {}, log: () => {} });
  kernel.spawn('p', linked.executable, ['p']);
  kernel.run();
  assert.equal(kernel.processes.get(1)!.exitCode, 41);
});

test('Phase 10: cross-object prototypes preserve pointer return types', () => {
  const objA = compileC(`int *get(); int main(int a, char **v){ return *(get() + 1); }`, {
    start: 'user',
  });
  const objB = compileC(`int xs[2]; int *get(){ xs[0]=11; xs[1]=22; return xs; }`, {
    start: 'none',
  });
  const linked = linkExecutable([objA, objB]);
  const kernel = new Kernel({ consoleSink: () => {}, log: () => {} });
  kernel.spawn('p', linked.executable, ['p']);
  kernel.run();
  assert.equal(kernel.processes.get(1)!.exitCode, 22);
});

test('Phase 10: duplicate public symbols are link errors', () => {
  const objA = compileC(`int helper(){ return 1; } int main(int a, char **v){ return helper(); }`);
  const objB = compileC(`int helper(){ return 2; }`, { start: 'none' });
  assert.throws(() => linkExecutable([objA, objB]), /duplicate text symbol: helper/);

  const dataA = compileC(`int g; int main(int a, char **v){ return 0; }`);
  const dataB = compileC(`int g;`, { start: 'none' });
  assert.throws(() => linkExecutable([dataA, dataB]), /duplicate bss symbol: g/);

  const runtimeCollision = compileC(
    `int memcpy(int d, int s, int n){ return 7; } int main(int a, char **v){ return 0; }`,
  );
  assert.throws(() => linkExecutable([runtimeCollision]), /duplicate text symbol: memcpy/);
});

test('Phase 10: kernel image data placement avoids or rejects segment overlap', () => {
  const source = `
    int pad[4096];
    int kmain() {
      return 0;
    }
  `;
  const obj = compileC(source, { start: 'kernel' });

  assert.throws(() => linkKernelImage([obj], { dataOrigin: 0x100 }), /kernel segments overlap/);

  const image = linkKernelImage([obj]);
  assert.ok(image.segments[1]!.vaddr >= image.segments[0]!.vaddr + image.segments[0]!.memSize);
});

test('Phase 10: compiles a tiny guest kernel image that uses port I/O', () => {
  const source = String.raw`
    int kmain() {
      __out(0x3f8, 'K');
      __out(0x3f8, '\n');
      return 0;
    }
  `;

  const image = linkKernelImage([compileC(source, { start: 'kernel' })]);
  assert.equal(image.entry, image.symbols.get('_start'));
  assert.equal(image.segments[0]!.flags, SEG.R | SEG.X);
  assert.equal(image.segments[1]!.flags, SEG.R | SEG.W);

  let out = '';
  const machine = new Machine({ physSize: 128 * 1024, consoleSink: (s) => (out += s) });
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry });
  const r = machine.run(10_000);

  assert.equal(r.reason, 'halt');
  assert.equal(out, 'K\n');
});
