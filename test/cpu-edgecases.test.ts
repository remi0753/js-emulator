// Edge-case coverage for the custom32 CPU's memory and decode fast paths.
//
// The CPU has hand-optimized fast paths for the common case (whole instruction or
// whole word inside one cached, in-range page) with byte-by-byte fallbacks for
// anything that could cross a page boundary. A correctness bug in either the fast
// path or its boundary condition would silently corrupt the guest, so these tests
// pin down the subtle behaviors:
//
//   - a word load/store whose 4 bytes straddle two virtual pages that map to
//     NON-contiguous physical frames (the byte-split fallback in rd32/wr32/rd16);
//   - an instruction whose encoding straddles a page boundary (the slow fetch);
//   - the software-TLB permission re-check (a write to a page cached by a prior
//     read must still fault if the page is read-only);
//   - sign- vs zero-extending byte/halfword loads;
//   - signed (IDIV/IMOD/SAR) vs unsigned (DIV/MOD/SHR) semantics with the high
//     bit set; and
//   - that a faulting instruction is restartable: registers and PC are left as if
//     it never began.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import { CPU, MODE } from '../src/vm/custom32/cpu.ts';
import { PAGE_SIZE, PhysicalMemory } from '../src/vm/custom32/memory.ts';
import { PTE } from '../src/vm/custom32/mmu.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

const MiB = 1024 * 1024;
const CODE_VA = 0x1000;
const STACK_TOP = 0x9000;

function frameAllocator(start: number) {
  let next = start;
  return () => {
    const f = next;
    next += PAGE_SIZE;
    return f;
  };
}

// Build a paged user/kernel address space: assemble `source` into a code frame
// mapped at CODE_VA, give it a writable stack, and run extra `map` callbacks to
// install whatever data pages the test needs. Returns the live CPU + phys memory.
function pagedMachine(
  source: string,
  opts: {
    mode?: (typeof MODE)[keyof typeof MODE];
    extraMaps?: (map: (va: number, frame: number, flags: number) => void, alloc: () => number) => void;
  } = {},
) {
  const phys = new PhysicalMemory(2 * MiB);
  const ports = new PortBus();
  const cpu = new CPU(phys, ports);
  const alloc = frameAllocator(0x40000);

  const pd = alloc();
  phys.zeroPage(pd);
  const codeFrame = alloc();
  const { bytes } = assemble(source);
  phys.bytes.set(bytes, codeFrame);

  const map = (va: number, frame: number, flags: number) => cpu.mmu.map(pd, va, frame, flags, alloc);
  map(CODE_VA, codeFrame, PTE.U); // code page: user-readable, not writable
  const stackFrame = alloc();
  map(STACK_TOP - PAGE_SIZE, stackFrame, PTE.U | PTE.W);
  opts.extraMaps?.(map, alloc);

  cpu.loadState({
    regs: new Array(8).fill(0),
    pc: CODE_VA,
    sp: STACK_TOP,
    flags: 0,
    mode: opts.mode ?? MODE.USER,
    ptbr: pd,
    pagingEnabled: true,
  });
  return { cpu, phys };
}

test('word store/load straddling two non-contiguous physical frames', () => {
  // Map VA 0x10000 -> frame A and VA 0x11000 -> frame B with B *below* A in
  // physical memory, so any code that assumed the second page is physically
  // contiguous with the first would put the high bytes in the wrong place.
  const frameB = 0x80000;
  const frameA = 0x90000; // deliberately A > B (reversed order)
  const { cpu, phys } = pagedMachine(
    `
      MOV R0, 0x12345678
      STORE R0, 0x100ffe   ; absolute-address store straddling the page boundary
      LOAD R2, 0x100ffe    ; read it back (offset 0xffe spills into the next page)
      INT 0x80
    `,
    {
      mode: MODE.KERNEL, // kernel so STORE/LOAD to writable data needs no U checks
      extraMaps: (map) => {
        map(0x100000, frameA, PTE.W);
        map(0x101000, frameB, PTE.W);
      },
    },
  );
  const r = cpu.run(100);
  assert.equal(r.reason, 'syscall');
  // Read-back round-trips the full 32-bit value.
  assert.equal(cpu.regs[2]! >>> 0, 0x12345678);
  // The individual bytes landed in the correct (non-contiguous) frames.
  assert.equal(phys.bytes[frameA + 0xffe]!, 0x78);
  assert.equal(phys.bytes[frameA + 0xfff]!, 0x56);
  assert.equal(phys.bytes[frameB + 0x000]!, 0x34);
  assert.equal(phys.bytes[frameB + 0x001]!, 0x12);
});

test('instruction encoding straddling a non-contiguous page boundary decodes correctly', () => {
  // Place a 6-byte `MOV R0, imm32` so its opcode/reg sit at the end of the first
  // page and the 4-byte immediate spills into the next page (a different frame).
  const phys = new PhysicalMemory(2 * MiB);
  const ports = new PortBus();
  const cpu = new CPU(phys, ports);
  const alloc = frameAllocator(0x40000);
  const pd = alloc();
  phys.zeroPage(pd);

  const frame0 = 0x90000; // backs VA 0x2000
  const frame1 = 0x70000; // backs VA 0x3000 (below frame0)
  const movBytes = assemble('MOV R0, 0xcafebabe').bytes; // 6 bytes
  const hltBytes = assemble('INT 0x80').bytes;

  // MOV starts at VA 0x2ffc: bytes 0x2ffc..0x2fff in frame0, 0x3000..0x3001 in frame1.
  const start = 0x2ffc;
  for (let i = 0; i < movBytes.length; i++) {
    const va = start + i;
    const frame = va < 0x3000 ? frame0 : frame1;
    phys.bytes[frame + (va & 0xfff)] = movBytes[i]!;
  }
  // The INT 0x80 lands at 0x3002 in frame1.
  for (let i = 0; i < hltBytes.length; i++) phys.bytes[frame1 + 2 + i] = hltBytes[i]!;

  cpu.mmu.map(pd, 0x2000, frame0, PTE.U, alloc);
  cpu.mmu.map(pd, 0x3000, frame1, PTE.U, alloc);
  cpu.loadState({
    regs: new Array(8).fill(0),
    pc: start,
    sp: STACK_TOP,
    flags: 0,
    mode: MODE.USER,
    ptbr: pd,
    pagingEnabled: true,
  });

  const r = cpu.run(100);
  assert.equal(r.reason, 'syscall');
  assert.equal(cpu.regs[0]! >>> 0, 0xcafebabe);
});

test('TLB permission re-check: a read does not let a later write skip the W bit', () => {
  // The data page is mapped user-readable but NOT writable. A LOAD caches the
  // translation in the TLB; the following STORE must still fault rather than be
  // served from the cached (writable-looking) entry.
  const dataFrame = 0x90000;
  const { cpu } = pagedMachine(
    `
      LOAD R0, 0x100000    ; read -> caches the TLB entry (write bit = 0)
      STORE R0, 0x100000   ; write to the read-only page -> must page fault
      INT 0x80
    `,
    {
      mode: MODE.USER,
      extraMaps: (map) => {
        map(0x100000, dataFrame, PTE.U); // read-only (no PTE.W)
      },
    },
  );
  const r = cpu.run(100);
  assert.equal(r.reason, 'pagefault');
  if (r.reason === 'pagefault') {
    assert.equal(r.vaddr, 0x100000);
    assert.equal(r.write, true);
    assert.equal(r.present, true); // protection violation, not a missing page
    assert.equal(r.user, true);
  }
});

test('sign- vs zero-extending byte and halfword loads', () => {
  const dataFrame = 0x90000;
  const { cpu } = pagedMachine(
    `
      MOV R7, 0x100000
      MOV R0, 0x80          ; high bit set in the byte
      SB R7, R0             ; mem8[0x100000] = 0x80
      MOV R0, 0xffff8123    ; low halfword 0x8123 (high bit set)
      MOV R6, 0x100004
      SH R6, R0             ; mem16[0x100004] = 0x8123

      LB R1, R7             ; zero-extended byte  -> 0x00000080
      LBS R2, R7            ; sign-extended byte   -> 0xffffff80
      LH R3, R6             ; zero-extended half   -> 0x00008123
      LHS R4, R6            ; sign-extended half   -> 0xffff8123
      INT 0x80
    `,
    {
      mode: MODE.KERNEL,
      extraMaps: (map) => {
        map(0x100000, dataFrame, PTE.W);
      },
    },
  );
  const r = cpu.run(100);
  assert.equal(r.reason, 'syscall');
  assert.equal(cpu.regs[1]! >>> 0, 0x00000080);
  assert.equal(cpu.regs[2]! >>> 0, 0xffffff80);
  assert.equal(cpu.regs[3]! >>> 0, 0x00008123);
  assert.equal(cpu.regs[4]! >>> 0, 0xffff8123);
});

test('signed vs unsigned division, remainder, and right shift with the high bit set', () => {
  const { cpu } = pagedMachine(
    `
      MOV R0, 0xfffffff6    ; -10 signed / 0xfffffff6 unsigned
      MOV R1, 4
      MOV R2, 0xfffffff6
      MOV R3, 0xfffffff6

      IDIV R0, R1           ; signed: -10 / 4 = -2  (0xfffffffe)
      IMOD R2, R1           ; signed: -10 % 4 = -2  (0xfffffffe)
      DIV R3, R1            ; unsigned: 0xfffffff6 / 4 = 0x3ffffffd

      MOV R4, 0x80000000
      MOV R5, 4
      SAR R4, R5            ; arithmetic >> 4 -> 0xf8000000
      MOV R6, 0x80000000
      SHR R6, R5            ; logical   >> 4 -> 0x08000000
      INT 0x80
    `,
    { mode: MODE.KERNEL },
  );
  const r = cpu.run(100);
  assert.equal(r.reason, 'syscall');
  assert.equal(cpu.regs[0]! >>> 0, 0xfffffffe, 'IDIV -10/4 = -2');
  assert.equal(cpu.regs[2]! >>> 0, 0xfffffffe, 'IMOD -10%4 = -2');
  assert.equal(cpu.regs[3]! >>> 0, 0x3ffffffd, 'DIV unsigned');
  assert.equal(cpu.regs[4]! >>> 0, 0xf8000000, 'SAR keeps the sign bit');
  assert.equal(cpu.regs[6]! >>> 0, 0x08000000, 'SHR shifts in zeros');
});

test('a faulting instruction is restartable: registers and PC are unchanged', () => {
  // MOV R0,99 then a LOAD from an unmapped address. The fault must leave PC at the
  // LOAD (not past it) and must not have written R1, so a handler could map the
  // page and let the instruction retry transparently.
  const { cpu } = pagedMachine(
    `
      MOV R0, 99
      LOAD R1, 0x40000000   ; unmapped -> page fault
      INT 0x80
    `,
    { mode: MODE.USER },
  );
  const r = cpu.run(100);
  assert.equal(r.reason, 'pagefault');
  // MOV R0,99 occupies 6 bytes at CODE_VA, so the LOAD begins at CODE_VA + 6.
  assert.equal(cpu.pc, CODE_VA + 6, 'PC rewound to the faulting instruction');
  assert.equal(cpu.regs[0], 99, 'the earlier instruction committed');
  assert.equal(cpu.regs[1], 0, 'the faulting load did not write its destination');
});
