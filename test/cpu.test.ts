import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import { FLAG, SYSCALL_INT } from '../src/isa.ts';
import { type Context, CPU, MEM_SIZE } from '../src/v1/cpu.ts';

// Assemble a program and build a single-process context.
function makeContext(source: string): Context {
  const { bytes } = assemble(source);
  const mem = new Uint8Array(MEM_SIZE);
  mem.set(bytes, 0);
  return { regs: new Array(8).fill(0), pc: 0, sp: MEM_SIZE, flags: 0, mem };
}

test('arithmetic: ADD / SUB / MUL and flags', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 20
      MOV R1, 22
      ADD R0, R1      ; R0 = 42
      MOV R2, 2
      MUL R0, R2      ; R0 = 84
      MOV R3, 84
      SUB R0, R3      ; R0 = 0 -> ZF
      HLT
    `),
  );
  const r = cpu.run(1000);
  assert.equal(r.reason, 'halt');
  assert.equal(cpu.regs[0], 0);
  assert.ok((cpu.flags & FLAG.ZF) !== 0, 'ZF should be set');
});

test('branching: loop computes 1+2+...+5 = 15', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 0       ; sum
      MOV R1, 1       ; counter
      MOV R2, 5       ; limit
      MOV R3, 1       ; constant 1
    loop:
      ADD R0, R1      ; sum += i
      CMP R1, R2      ; i - 5
      JZ done         ; stop when i == 5
      ADD R1, R3      ; i++
      JMP loop
    done:
      HLT
    `),
  );
  const r = cpu.run(10000);
  assert.equal(r.reason, 'halt');
  assert.equal(cpu.regs[0], 15);
});

test('signed branches: JL / JG', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 3
      MOV R1, 10
      CMP R0, R1      ; 3 - 10 < 0 -> SF
      JL less
      MOV R2, 100     ; not taken
      HLT
    less:
      MOV R2, 7
      HLT
    `),
  );
  cpu.run(1000);
  assert.equal(cpu.regs[2], 7);
});

test('WRITE-like: INT 0x80 stops and exposes R0/R1', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 1       ; syscall WRITE
      MOV R1, 'A'     ; char
      INT 0x80
      HLT
    `),
  );
  const r = cpu.run(1000);
  assert.equal(r.reason, 'int');
  assert.equal(r.reason === 'int' && r.int, SYSCALL_INT);
  assert.equal(cpu.regs[0], 1);
  assert.equal(cpu.regs[1], 'A'.charCodeAt(0));
  // resumes right after INT
  const r2 = cpu.run(1000);
  assert.equal(r2.reason, 'halt');
});

test('stack: PUSH / POP / CALL / RET', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 0
      MOV R1, 5
      CALL addfive    ; R0 += 5
      CALL addfive    ; R0 += 5
      HLT
    addfive:
      ADD R0, R1
      RET
    `),
  );
  const r = cpu.run(1000);
  assert.equal(r.reason, 'halt');
  assert.equal(cpu.regs[0], 10);
});

test('quantum: reason=quantum when maxCycles is reached', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
    spin:
      NOP
      JMP spin
    `),
  );
  const r = cpu.run(50);
  assert.equal(r.reason, 'quantum');
});

test('faults: divide-by-zero and illegal opcode', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 10
      MOV R1, 0
      DIV R0, R1
      HLT
    `),
  );
  const r = cpu.run(1000);
  assert.equal(r.reason, 'fault');

  // illegal opcode (0xEE is undefined)
  const ctx: Context = {
    regs: new Array(8).fill(0),
    pc: 0,
    sp: MEM_SIZE,
    flags: 0,
    mem: new Uint8Array(MEM_SIZE),
  };
  ctx.mem[0] = 0xee;
  const cpu2 = new CPU();
  cpu2.loadContext(ctx);
  assert.equal(cpu2.run(10).reason, 'fault');
});

test('context switch: save/load keeps two independent states', () => {
  const cpu = new CPU();
  const a = makeContext(`spin: ADD R0, R1\nJMP spin`);
  a.regs[1] = 1; // A increments R0 by 1
  const b = makeContext(`spin: ADD R0, R1\nJMP spin`);
  b.regs[1] = 10; // B increments R0 by 10

  for (let i = 0; i < 3; i++) {
    cpu.loadContext(a);
    cpu.run(4);
    cpu.saveContext(a);

    cpu.loadContext(b);
    cpu.run(4);
    cpu.saveContext(b);
  }
  // each accumulated independently
  assert.ok(a.regs[0]! > 0);
  assert.ok(b.regs[0]! > a.regs[0]!);
});
