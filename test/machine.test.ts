import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import { MODE } from '../src/vm/custom32/cpu.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PTE } from '../src/vm/custom32/mmu.ts';
import { PORT } from '../src/vm/custom32/platform.ts';

// Phase 7 acceptance: a test can create a blank machine, load guest bytes at a
// physical address, run until a trap/halt, and inspect only hardware-visible
// state — with no kernel, scheduler, process table, or syscall dispatch.
test('blank machine: load, reset, run to halt, inspect hardware state', () => {
  const machine = new Machine({ physSize: 64 * 1024 });
  const { bytes } = assemble(`
    MOV R0, 7
    MOV R1, 35
    ADD R0, R1
    STORE R0, 0x100   ; write the result to physical address 0x100
    HLT
  `);
  machine.load(0, bytes);
  machine.reset(); // pc=0, KERNEL mode, paging off

  const r = machine.run(100);

  assert.equal(r.reason, 'halt');
  assert.equal(machine.cpu.regs[0], 42);
  assert.equal(machine.cpu.mode, MODE.KERNEL);
  assert.equal(machine.phys.read32(0x100), 42); // visible in physical RAM
});

test('machine.reset can enter at a load address and override the stack', () => {
  const machine = new Machine({ physSize: 64 * 1024 });
  const { bytes } = assemble('MOV R0, 1\nHLT');
  machine.load(0x2000, bytes);
  machine.reset({ pc: 0x2000, sp: 0x1000 });

  assert.equal(machine.cpu.pc, 0x2000);
  assert.equal(machine.cpu.sp, 0x1000);
  assert.equal(machine.run(10).reason, 'halt');
  assert.equal(machine.cpu.regs[0], 1);
});

test('machine.run surfaces a syscall trap (INT) to the host', () => {
  const machine = new Machine({ physSize: 64 * 1024 });
  const { bytes } = assemble('MOV R0, 9\nINT 0x80\nHLT');
  machine.load(0, bytes);
  machine.reset();

  const r = machine.run(100);
  assert.equal(r.reason, 'syscall');
  assert.equal(r.reason === 'syscall' && r.num, 0x80);
});

test('tracer records instructions, traps, and port I/O', () => {
  const machine = new Machine({ physSize: 64 * 1024, trace: true });
  const tracer = machine.tracer!;
  assert.ok(tracer);

  const { bytes } = assemble(`
    MOV R1, ${PORT.CONSOLE_DATA}
    MOV R2, 65        ; 'A'
    OUT R1, R2        ; emit one character through the port bus
    HLT
  `);
  machine.load(0, bytes);
  machine.reset();
  machine.run(100);

  // Instruction trace: every executed mnemonic, in order, starting at pc 0.
  assert.deepEqual(
    tracer.instr.map((e) => e.mnemonic),
    ['MOV', 'MOV', 'OUT', 'HLT'],
  );
  assert.equal(tracer.instr[0]!.pc, 0);

  // Port I/O trace: the OUT to the console port.
  assert.equal(tracer.ports.length, 1);
  assert.deepEqual(
    { dir: tracer.ports[0]!.dir, port: tracer.ports[0]!.port, value: tracer.ports[0]!.value },
    { dir: 'out', port: PORT.CONSOLE_DATA, value: 65 },
  );
  assert.equal(machine.console.output, 'A');

  // Trap trace: the final halt.
  assert.equal(tracer.traps.at(-1)!.result.reason, 'halt');
});

test('tracer records disk I/O at sector granularity', () => {
  const machine = new Machine({ physSize: 64 * 1024, diskBlocks: 4, trace: { disk: true } });
  const tracer = machine.tracer!;

  // Seek to sector 1, write one word, then seek + read it back.
  const { bytes } = assemble(`
    MOV R1, ${PORT.DISK_POS}
    MOV R2, 1
    OUT R1, R2          ; seek to sector 1
    MOV R1, ${PORT.DISK_DATA}
    MOV R2, 0xdead
    OUT R1, R2          ; write a word
    MOV R1, ${PORT.DISK_POS}
    MOV R2, 1
    OUT R1, R2          ; seek back to sector 1
    MOV R1, ${PORT.DISK_DATA}
    IN  R0, R1          ; read the word back
    HLT
  `);
  machine.load(0, bytes);
  machine.reset();
  machine.run(200);

  assert.equal(machine.cpu.regs[0], 0xdead);
  assert.deepEqual(
    tracer.disk.map((e) => e.op),
    ['seek', 'write', 'seek', 'read'],
  );
  // The write/read landed at sector 1's byte offset (512).
  assert.equal(tracer.disk[1]!.at, 512);
  assert.equal(tracer.disk[3]!.value, 0xdead);
});

test('tracer can dump a page table built by the MMU', () => {
  const machine = new Machine({ physSize: 1024 * 1024, trace: true });
  const alloc = (() => {
    let next = 0x10000;
    return () => {
      const f = next;
      next += 4096;
      return f;
    };
  })();
  const pd = alloc();
  machine.phys.zeroPage(pd);
  const frame = alloc();
  machine.cpu.mmu.map(pd, 0x4000, frame, PTE.U | PTE.W, alloc);

  const mappings = machine.tracer!.pageTable(pd);
  const m = mappings.find((x) => x.vaddr === 0x4000);
  assert.ok(m, 'expected a mapping for vaddr 0x4000');
  assert.equal(m!.paddr, frame);
  assert.ok((m!.flags & PTE.U) !== 0);
  assert.ok((m!.flags & PTE.W) !== 0);
});

test('detached tracer records nothing (zero-overhead default)', () => {
  const machine = new Machine({ physSize: 64 * 1024, trace: true });
  const tracer = machine.tracer!;
  tracer.detach();

  const { bytes } = assemble('MOV R0, 1\nHLT');
  machine.load(0, bytes);
  machine.reset();
  machine.run(10);

  assert.equal(tracer.instr.length, 0);
  assert.equal(tracer.traps.length, 0);
});
