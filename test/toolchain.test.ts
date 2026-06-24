import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileC } from '../src/toolchain/c.ts';
import { linkExecutable, linkKernelImage } from '../src/toolchain/linker.ts';
import { preprocess } from '../src/toolchain/preprocess.ts';
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
  return runFull(`int main(int argc, char **argv){ ${body} }`);
}

function runFull(source: string): number {
  const linked = linkExecutable([compileC(source)]);
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

test('function pointers: dispatch through a table and a variable', () => {
  // A function name is a value (its address); calling through a table entry or a
  // variable holding an address compiles to an indirect call (CALLR).
  const source = `
    int add(int a, int b) { return a + b; }
    int mul(int a, int b) { return a * b; }
    int table[2];
    int main(int argc, char **argv) {
      int fp;
      table[0] = add;
      table[1] = mul;
      fp = add;
      // table[1](6,7)=42, table[0](1,2)=3, fp(10,5)=15 -> 60
      return table[1](6, 7) + table[0](1, 2) + fp(10, 5);
    }
  `;
  assert.equal(runFull(source), 60);
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

test('preprocess: expands includes once and strips guard directives', () => {
  const headers: Record<string, string> = {
    'a.h': '#ifndef A_H\n#define A_H\n#include "b.h"\nint from_a;\n#endif\n',
    'b.h': '#pragma once\nint from_b;\n',
  };
  const out = preprocess('#include "a.h"\n#include "b.h"\nint root;\n', (n) => headers[n]);
  assert.match(out, /int from_b;/);
  assert.match(out, /int from_a;/);
  assert.match(out, /int root;/);
  // b.h is included transitively via a.h, then again directly: it appears once.
  assert.equal(out.match(/int from_b;/g)!.length, 1);
  // Guard/pragma directives are removed.
  assert.doesNotMatch(out, /#/);
});

test('preprocess: unresolved include is an error', () => {
  assert.throws(() => preprocess('#include "missing.h"\n', () => undefined), /cannot resolve/);
});

test('modules: a shared header carries a struct, prototype, and extern global', () => {
  const header = `
    struct pair { int a; int b; };
    extern int shared_total;
    int add_pair(struct pair *p);
  `;
  const resolve = (name: string): string | undefined =>
    name === 'shared.h' ? header : undefined;

  // The defining object owns shared_total; kmain calls into the other object,
  // which writes the extern and reads the struct through the shared layout.
  const main = preprocess(
    `#include "shared.h"
     int shared_total;
     int kmain() {
       struct pair p;
       int r;
       p.a = 7;
       p.b = 3;
       r = add_pair(&p);
       __out(0x3f8, r + shared_total);
       __halt();
       return 0;
     }`,
    resolve,
  );
  const helper = preprocess(
    `#include "shared.h"
     int add_pair(struct pair *p) {
       shared_total = p->a;
       return p->a + p->b;
     }`,
    resolve,
  );

  const image = linkKernelImage([
    compileC(main, { start: 'kernel', moduleId: 'main' }),
    compileC(helper, { start: 'none', moduleId: 'helper' }),
  ]);

  let out = '';
  const machine = new Machine({ physSize: 128 * 1024, consoleSink: (s) => (out += s) });
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry });
  const r = machine.run(10_000);

  assert.equal(r.reason, 'halt');
  // r = 10 (a + b), shared_total = 7 (a) written from the other object.
  assert.equal(out.charCodeAt(0), 17);
});

test('modules: struct-typed extern arrays parse and resolve across objects', () => {
  const header = `
    struct proc { int pid; int state; };
    extern struct proc table[4];
  `;
  const resolve = (name: string): string | undefined => (name === 'k.h' ? header : undefined);

  const reader = compileC(
    preprocess(`#include "k.h"\nint pid_of(int i) { return table[i].pid; }`, resolve),
    { start: 'none', moduleId: 'reader' },
  );
  const owner = compileC(
    preprocess(
      `#include "k.h"
       struct proc table[4];
       int kmain() {
         table[2].pid = 99;
         __out(0x3f8, pid_of(2));
         __halt();
         return 0;
       }`,
      resolve,
    ),
    { start: 'kernel', moduleId: 'owner' },
  );

  const image = linkKernelImage([owner, reader]);
  let out = '';
  const machine = new Machine({ physSize: 128 * 1024, consoleSink: (s) => (out += s) });
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry });
  assert.equal(machine.run(10_000).reason, 'halt');
  assert.equal(out.charCodeAt(0), 99);
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
