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
