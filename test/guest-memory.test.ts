import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileC } from '../src/toolchain/c.ts';
import { linkKernelImage } from '../src/toolchain/linker.ts';
import { preprocess } from '../src/toolchain/preprocess.ts';
import { GUEST_KERNEL_DEFINES } from '../src/v3/config.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

const kernelSource = (name: string): string =>
  readFileSync(new URL(`../src/v3/kernel/${name}`, import.meta.url), 'utf8');

function configured(source: string): string {
  for (const key of Object.keys(GUEST_KERNEL_DEFINES).sort((a, b) => b.length - a.length)) {
    source = source.replace(
      new RegExp(`\\b${key}\\b`, 'g'),
      String(GUEST_KERNEL_DEFINES[key]),
    );
  }
  return source;
}

test('copyin/copyout translate through the requested process address space', () => {
  const resolve = (name: string): string | undefined =>
    name === 'kernel.h' ? kernelSource('kernel.h') : undefined;
  const memory = configured(preprocess(kernelSource('memory.c'), resolve));
  const harness = configured(
    preprocess(
      `
        #include "kernel.h"

        int nproc;
        struct proc proc_table[CFG_MAX_PROC];
        int pd0_store[2048];
        int pt0_store[2048];
        int frame0_store[2048];
        int pd1_store[2048];
        int pt1_store[2048];
        int frame1_store[2048];
        char kbuf[2];

        void serial_putc(int ch) { __out(CFG_CONSOLE_DATA, ch); }
        void serial_write(char *s) { }
        void panic(char *msg) { __halt(); }

        int kmain(void) {
          int *pd0;
          int *pt0;
          int *frame0;
          int *pd1;
          int *pt1;
          int *frame1;
          pd0 = (pd0_store + 1023) & 0xfffff000;
          pt0 = (pt0_store + 1023) & 0xfffff000;
          frame0 = (frame0_store + 1023) & 0xfffff000;
          pd1 = (pd1_store + 1023) & 0xfffff000;
          pt1 = (pt1_store + 1023) & 0xfffff000;
          frame1 = (frame1_store + 1023) & 0xfffff000;
          memset(pd0, 0, 4096);
          memset(pt0, 0, 4096);
          memset(pd1, 0, 4096);
          memset(pt1, 0, 4096);
          pd0[1] = pt0 | CFG_PTE_USER;
          pd1[1] = pt1 | CFG_PTE_USER;
          pt0[0] = frame0 | CFG_PTE_USER;
          pt1[0] = frame1 | CFG_PTE_USER;
          frame0[0] = 'A';
          frame1[0] = 'B';
          nproc = 2;
          proc_table[0].vm.ptbr = pd0;
          proc_table[1].vm.ptbr = pd1;

          if (copyin(1, kbuf, CFG_USER_BASE, 1) < 0) return 1;
          serial_putc(kbuf[0]);
          kbuf[0] = 'C';
          if (copyout(1, CFG_USER_BASE, kbuf, 1) < 0) return 2;
          serial_putc(frame0[0]);
          serial_putc(frame1[0]);
          __halt();
          return 0;
        }
      `,
      resolve,
    ),
  );

  const image = linkKernelImage([
    compileC(harness, { start: 'kernel', moduleId: 'memory_test' }),
    compileC(memory, { start: 'none', moduleId: 'memory_impl' }),
  ]);
  let output = '';
  const machine = new Machine({
    physSize: 512 * 1024,
    consoleSink: (text) => (output += text),
  });
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry });

  assert.equal(machine.run(1_000_000).reason, 'halt');
  assert.equal(output, 'BAC');
});
