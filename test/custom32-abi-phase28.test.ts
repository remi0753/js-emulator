import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import { compileC } from '../src/toolchain/c.ts';
import { linkExecutable } from '../src/toolchain/linker.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

function runAsm(source: string): Machine {
  const { bytes } = assemble(source);
  const machine = new Machine({ physSize: 64 * 1024 });
  machine.load(0, bytes);
  machine.reset({ pc: 0, sp: 0xf000 });
  assert.equal(machine.run(10_000).reason, 'halt');
  return machine;
}

function runCExit(body: string): number {
  const linked = linkExecutable([
    compileC(`int main(int argc, char **argv) { ${body} }`),
  ]);
  const kernel = new Kernel({ consoleSink: () => {}, log: () => {} });
  kernel.spawn('phase28', linked.executable, ['phase28']);
  kernel.run();
  return kernel.processes.get(1)!.exitCode!;
}

test('Phase 28 custom32 comparisons handle signed overflow and unsigned order', () => {
  const machine = runAsm(`
    MOV R0, 0x80000000
    MOV R1, 1
    CMP R0, R1
    JL signed_less
    HLT
  signed_less:
    MOV R2, 1

    MOV R0, 0x7fffffff
    MOV R1, 0xffffffff
    CMP R0, R1
    JG signed_greater
    HLT
  signed_greater:
    MOV R3, 1

    MOV R0, 0xffffffff
    MOV R1, 1
    CMP R0, R1
    JA unsigned_above
    HLT
  unsigned_above:
    MOV R4, 1

    MOV R0, 1
    MOV R1, 0xffffffff
    CMP R0, R1
    JB unsigned_below
    HLT
  unsigned_below:
    MOV R5, 1

    MOV R0, 5
    MOV R1, 5
    CMP R0, R1
    JBE unsigned_equal_or_below
    HLT
  unsigned_equal_or_below:
    MOV R6, 1
    HLT
  `);

  assert.equal(machine.cpu.regs[2], 1);
  assert.equal(machine.cpu.regs[3], 1);
  assert.equal(machine.cpu.regs[4], 1);
  assert.equal(machine.cpu.regs[5], 1);
  assert.equal(machine.cpu.regs[6], 1);
});

test('Phase 28 custom32 exposes signed and unsigned divide, remainder, and shifts', () => {
  const machine = runAsm(`
    MOV R0, -7
    MOV R1, 2
    IDIV R0, R1

    MOV R2, -7
    IMOD R2, R1

    MOV R3, 0xffffffff
    DIV R3, R1

    MOV R4, 0xffffffff
    MOD R4, R1

    MOV R5, 0x80000000
    SAR R5, R1

    MOV R6, 0x80000000
    SHR R6, R1
    HLT
  `);

  assert.equal(machine.cpu.regs[0]! >>> 0, 0xfffffffd);
  assert.equal(machine.cpu.regs[2]! >>> 0, 0xffffffff);
  assert.equal(machine.cpu.regs[3]! >>> 0, 0x7fffffff);
  assert.equal(machine.cpu.regs[4], 1);
  assert.equal(machine.cpu.regs[5]! >>> 0, 0xe0000000);
  assert.equal(machine.cpu.regs[6]! >>> 0, 0x20000000);
});

test('Phase 28 custom32 has sign-extending byte and halfword memory operations', () => {
  const machine = runAsm(`
    MOV R6, data
    LB R0, R6
    LBS R1, R6
    LH R2, R6
    LHS R3, R6
    MOV R4, 4
    ADD R6, R4
    MOV R4, 0x1234
    SH R6, R4
    LH R5, R6
    HLT
  data:
    .word 0x0080ff80
    .word 0
  `);

  assert.equal(machine.cpu.regs[0], 0x80);
  assert.equal(machine.cpu.regs[1]! >>> 0, 0xffffff80);
  assert.equal(machine.cpu.regs[2], 0xff80);
  assert.equal(machine.cpu.regs[3]! >>> 0, 0xffffff80);
  assert.equal(machine.cpu.regs[5], 0x1234);
});

test('Phase 28 bootstrap C compiler uses signed int arithmetic instructions', () => {
  assert.equal(runCExit('if (-2147483648 < 1) return 7; return 1;'), 7);
  assert.equal(runCExit('return -7 / 2 + 10;'), 7);
  assert.equal(runCExit('return -7 % 2 + 10;'), 9);
  assert.equal(runCExit('return (-8 >> 1) + 10;'), 6);
});
