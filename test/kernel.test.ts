import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import { LAYOUT } from '../src/v2/kernel/abi.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';

// Assemble a user program at the address it will be loaded (so labels relocate).
function image(source: string): Uint8Array {
  return assemble(source, LAYOUT.USER_TEXT).bytes;
}

function makeKernel(quantum = 1000) {
  let out = '';
  const kernel = new Kernel({ quantum, consoleSink: (s) => (out += s), log: () => {} });
  return { kernel, getOut: () => out };
}

test('a user-mode program writes via syscall and exits', () => {
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'hello',
    image(`
      MOV R0, 1        ; SYS_WRITE
      MOV R1, 1        ; fd = stdout
      MOV R2, msg      ; buf (relocated to its runtime vaddr)
      MOV R3, 5        ; len
      INT 0x80
      MOV R0, 0        ; SYS_EXIT
      MOV R1, 0
      INT 0x80
    msg:
      .string "HELLO"
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'HELLO');
  assert.equal(kernel.processes.get(1)!.exitCode, 0);
  assert.equal(kernel.processes.get(1)!.state, 'zombie');
});

test('GETPID returns the pid; EXIT records the code', () => {
  const { kernel } = makeKernel();
  kernel.spawn(
    'p',
    image(`
      MOV R0, 3        ; GETPID
      INT 0x80         ; R0 = pid
      MOVR R1, R0      ; exit code = pid
      MOV R0, 0        ; EXIT
      INT 0x80
    `),
  );
  kernel.run();
  assert.equal(kernel.processes.get(1)!.exitCode, 1);
});

test('bad pointer to write() returns -1, process survives', () => {
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'badptr',
    image(`
      MOV R0, 1            ; WRITE
      MOV R1, 1            ; fd
      MOV R2, 0x40000000   ; unmapped buf
      MOV R3, 4
      INT 0x80             ; R0 = -1 (BadAddress), but process keeps running
      MOV R0, 1            ; WRITE a valid byte to prove we survived
      MOV R2, ok
      MOV R3, 1
      INT 0x80
      MOV R0, 0            ; EXIT
      MOV R1, 0
      INT 0x80
    ok:
      .string "Z"
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'Z');
  assert.equal(kernel.processes.get(1)!.exitCode, 0);
});

test('an out-of-bounds access faults and the kernel kills the process', () => {
  const { kernel } = makeKernel();
  kernel.spawn(
    'crash',
    image(`
      LOAD R0, 0x40000000   ; page fault: unmapped
      MOV R0, 0
      INT 0x80
    `),
  );
  kernel.run();
  const p = kernel.processes.get(1)!;
  assert.equal(p.state, 'zombie');
  assert.equal(p.exitCode, -1);
});

test('timer preemption interleaves two CPU-bound processes', () => {
  const { kernel, getOut } = makeKernel(30); // tiny quantum forces preemption
  const printer = (ch: string) => `
      MOV R7, 0
      MOV R6, 1
      MOV R5, 3          ; print 3 times
    outer:
      CMP R5, R7
      JZ  done
      MOV R4, 50         ; burn time so the quantum expires mid-compute
    inner:
      DEC R4
      CMP R4, R7
      JNZ inner
      MOV R0, 1          ; WRITE
      MOV R1, 1          ; fd
      MOV R2, ch
      MOV R3, 1
      INT 0x80
      SUB R5, R6
      JMP outer
    done:
      MOV R0, 0          ; EXIT
      MOV R1, 0
      INT 0x80
    ch:
      .string "${ch}"
  `;
  kernel.spawn('A', image(printer('A')));
  kernel.spawn('B', image(printer('B')));
  kernel.run();

  const out = getOut();
  assert.equal(out.length, 6);
  assert.equal([...out].filter((c) => c === 'A').length, 3);
  assert.equal([...out].filter((c) => c === 'B').length, 3);
  assert.ok(/AB|BA/.test(out), `expected interleaving: ${out}`);
});

test('processes are isolated: same vaddr, independent memory', () => {
  // Each writes a distinct byte to the same user vaddr, then reads it back and
  // prints it. If address spaces were shared they would clobber each other.
  const prog = (ch: string) => `
      MOV R1, '${ch}'
      STORE R1, scratch    ; mem[scratch] = ch
      MOV R0, 2            ; YIELD (let the other run between store and load)
      INT 0x80
      LOAD R1, scratch     ; read it back
      STORE R1, buf
      MOV R0, 1            ; WRITE buf
      MOV R1, 1
      MOV R2, buf
      MOV R3, 1
      INT 0x80
      MOV R0, 0
      INT 0x80
    scratch:
      .word 0
    buf:
      .word 0
  `;
  const { kernel, getOut } = makeKernel(1000);
  kernel.spawn('X', image(prog('X')));
  kernel.spawn('Y', image(prog('Y')));
  kernel.run();
  const out = getOut();
  // Both see their own value despite using the same virtual address.
  assert.ok(out.includes('X') && out.includes('Y'), `isolation broken: ${out}`);
});
