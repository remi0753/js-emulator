import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import { CPU, MODE } from '../src/hw/cpu.ts';
import { PAGE_SIZE, PhysicalMemory } from '../src/hw/memory.ts';
import { PTE } from '../src/hw/mmu.ts';
import { PortBus, type PortDevice } from '../src/hw/ports.ts';

const MiB = 1024 * 1024;

// A simple bump frame allocator for tests.
function frameAllocator(start: number) {
  let next = start;
  return () => {
    const f = next;
    next += PAGE_SIZE;
    return f;
  };
}

function newMachine(physSize = MiB) {
  const phys = new PhysicalMemory(physSize);
  const ports = new PortBus();
  const cpu = new CPU(phys, ports);
  return { phys, ports, cpu };
}

test('flat (paging off) execution in kernel mode', () => {
  const { phys, cpu } = newMachine();
  const { bytes } = assemble('MOV R0, 42\nHLT');
  phys.bytes.set(bytes, 0);

  cpu.loadState({
    regs: new Array(8).fill(0),
    pc: 0,
    sp: phys.size,
    flags: 0,
    mode: MODE.KERNEL,
    ptbr: 0,
    pagingEnabled: false,
  });
  const r = cpu.run(100);
  assert.equal(r.reason, 'halt');
  assert.equal(cpu.regs[0], 42);
});

test('paging on / user mode: address translation runs and traps on syscall', () => {
  const { phys, cpu } = newMachine();
  const alloc = frameAllocator(0x10000);

  const pd = alloc();
  phys.zeroPage(pd);
  const codeFrame = alloc();
  const stackFrame = alloc();

  const { bytes } = assemble('MOV R0, 42\nINT 0x80');
  phys.bytes.set(bytes, codeFrame);

  // Map user virtual addresses to physical frames.
  cpu.mmu.map(pd, 0x1000, codeFrame, PTE.U, alloc); // code (readable)
  cpu.mmu.map(pd, 0x8000, stackFrame, PTE.U | PTE.W, alloc); // stack

  cpu.loadState({
    regs: new Array(8).fill(0),
    pc: 0x1000,
    sp: 0x9000,
    flags: 0,
    mode: MODE.USER,
    ptbr: pd,
    pagingEnabled: true,
  });
  const r = cpu.run(100);
  assert.equal(r.reason, 'syscall');
  assert.equal(r.reason === 'syscall' && r.num, 0x80);
  assert.equal(cpu.regs[0], 42);
});

test('page fault: accessing an unmapped virtual address traps', () => {
  const { phys, cpu } = newMachine();
  const alloc = frameAllocator(0x10000);
  const pd = alloc();
  phys.zeroPage(pd);
  const codeFrame = alloc();

  const { bytes } = assemble('LOAD R0, 0x40000000\nINT 0x80');
  phys.bytes.set(bytes, codeFrame);
  cpu.mmu.map(pd, 0x1000, codeFrame, PTE.U, alloc);

  cpu.loadState({
    regs: new Array(8).fill(0),
    pc: 0x1000,
    sp: 0x9000,
    flags: 0,
    mode: MODE.USER,
    ptbr: pd,
    pagingEnabled: true,
  });
  const r = cpu.run(100);
  assert.equal(r.reason, 'pagefault');
  if (r.reason === 'pagefault') {
    assert.equal(r.vaddr, 0x40000000);
    assert.equal(r.present, false);
    assert.equal(r.user, true);
    assert.equal(r.write, false);
    assert.equal(cpu.pfla, 0x40000000);
  }
});

test('privilege violation: a privileged instruction in user mode traps', () => {
  const { phys, cpu } = newMachine();
  const alloc = frameAllocator(0x10000);
  const pd = alloc();
  phys.zeroPage(pd);
  const codeFrame = alloc();

  const { bytes } = assemble('EI'); // EI is privileged
  phys.bytes.set(bytes, codeFrame);
  cpu.mmu.map(pd, 0x1000, codeFrame, PTE.U, alloc);

  cpu.loadState({
    regs: new Array(8).fill(0),
    pc: 0x1000,
    sp: 0x9000,
    flags: 0,
    mode: MODE.USER,
    ptbr: pd,
    pagingEnabled: true,
  });
  const r = cpu.run(100);
  assert.equal(r.reason, 'fault');
  assert.equal(r.reason === 'fault' && r.kind, 'privileged');
});

test('user cannot access a supervisor page (no U bit)', () => {
  const { phys, cpu } = newMachine();
  const alloc = frameAllocator(0x10000);
  const pd = alloc();
  phys.zeroPage(pd);
  const codeFrame = alloc();
  const kpage = alloc();

  const { bytes } = assemble('LOAD R0, 0x20000\nINT 0x80');
  phys.bytes.set(bytes, codeFrame);
  cpu.mmu.map(pd, 0x1000, codeFrame, PTE.U, alloc);
  cpu.mmu.map(pd, 0x20000, kpage, PTE.W, alloc); // no U bit = supervisor only

  cpu.loadState({
    regs: new Array(8).fill(0),
    pc: 0x1000,
    sp: 0x9000,
    flags: 0,
    mode: MODE.USER,
    ptbr: pd,
    pagingEnabled: true,
  });
  const r = cpu.run(100);
  assert.equal(r.reason, 'pagefault');
  assert.equal(r.reason === 'pagefault' && r.present, true); // present but protection violation
});

test('port I/O: OUT writes and IN reads it back (kernel mode)', () => {
  const { phys, ports, cpu } = newMachine();

  // A tiny device on port 5 that stores the written value.
  let stored = 0;
  const dev: PortDevice = {
    read: () => stored,
    write: (_port, v) => {
      stored = v;
    },
  };
  ports.register(5, 1, dev);

  const { bytes } = assemble(`
    MOV R1, 5
    MOV R2, 99
    OUT R1, R2     ; port[5] = 99
    IN  R0, R1     ; R0 = port[5]
    HLT
  `);
  phys.bytes.set(bytes, 0);

  cpu.loadState({
    regs: new Array(8).fill(0),
    pc: 0,
    sp: phys.size,
    flags: 0,
    mode: MODE.KERNEL,
    ptbr: 0,
    pagingEnabled: false,
  });
  const r = cpu.run(100);
  assert.equal(r.reason, 'halt');
  assert.equal(stored, 99);
  assert.equal(cpu.regs[0], 99);
});

test('quantum expiry returns reason=timer', () => {
  const { phys, cpu } = newMachine();
  const { bytes } = assemble('spin: JMP spin');
  phys.bytes.set(bytes, 0);
  cpu.loadState({
    regs: new Array(8).fill(0),
    pc: 0,
    sp: phys.size,
    flags: 0,
    mode: MODE.KERNEL,
    ptbr: 0,
    pagingEnabled: false,
  });
  assert.equal(cpu.run(50).reason, 'timer');
});

test('IRQ: returns to kernel when IF is set', () => {
  const { phys, cpu } = newMachine();
  const { bytes } = assemble('EI\nspin: JMP spin');
  phys.bytes.set(bytes, 0);
  cpu.loadState({
    regs: new Array(8).fill(0),
    pc: 0,
    sp: phys.size,
    flags: 0,
    mode: MODE.KERNEL,
    ptbr: 0,
    pagingEnabled: false,
  });
  cpu.run(5); // execute EI to set IF
  cpu.raiseIrq(3);
  const r = cpu.run(50);
  assert.equal(r.reason, 'irq');
  assert.equal(r.reason === 'irq' && r.line, 3);
});
