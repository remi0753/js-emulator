import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import { MODE } from '../src/vm/custom32/cpu.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PTE, dirIndex, tableIndex } from '../src/vm/custom32/mmu.ts';

// Phase 8: real in-CPU trap and interrupt entry. A guest kernel written in
// assembly installs an IDT, takes traps in KERNEL mode, and returns with IRET —
// all without any TypeScript scheduler or syscall dispatch help.

const ADDR_MASK = 0xfffff000;
const IF = 1 << 3; // FLAG.IF — user runs with interrupts enabled so it can be preempted

// --- 1. syscall: INT 0x80 enters a guest handler that returns with IRET -------

test('guest kernel: INT 0x80 vectors to a handler and IRET resumes user mode', () => {
  // Layout (paging off, physical = virtual): IDT at 0x8000, kernel stack top
  // 0x5000, user stack top 0x4000. The guest installs vector 0x80 itself.
  const { bytes, labels } = assemble(`
    boot:
      MOV R1, 0x8000
      LIDT R1                 ; install the interrupt descriptor table
      MOV R2, 0x8400          ; &IDT[0x80]  (0x80 * 8)
      MOV R3, sys_handler
      STORER R2, R3           ; IDT[0x80].offset = handler
      MOV R2, 0x8404
      MOV R3, 1
      STORER R2, R3           ; IDT[0x80].flags = Present
      MOV R1, 0x5000
      LKSP R1                 ; kernel stack pointer (esp0)
      ; drop to user mode by IRETing into a synthetic trap frame
      MOV R0, 0x4000          ; user sp
      PUSH R0
      MOV R0, 0               ; user flags
      PUSH R0
      MOV R0, 1               ; USER mode
      PUSH R0
      MOV R0, user            ; user entry
      PUSH R0
      IRET

    user:
      MOV R0, 1               ; syscall #1 ("bump the counter")
      INT 0x80
      MOV R3, 0xBEEF          ; we only reach here if IRET resumed us in user mode
      STORE R3, marker
      MOV R0, 0               ; syscall #0 ("exit")
      INT 0x80

    sys_handler:
      PUSH R6                 ; a handler must preserve the regs it clobbers
      PUSH R7
      MOV R7, 0
      CMP R0, R7
      JZ sys_exit
      LOAD R6, counter
      INC R6
      STORE R6, counter
      POP R7
      POP R6
      IRET                    ; back to user, just after the INT
    sys_exit:
      HLT

    counter: .word 0
    marker:  .word 0
  `);

  const machine = new Machine({ physSize: 64 * 1024 });
  machine.load(0, bytes);
  machine.reset(); // KERNEL mode, paging off, pc = 0

  const r = machine.run(10000);

  assert.equal(r.reason, 'halt');
  assert.equal(machine.cpu.mode, MODE.KERNEL); // halted inside the handler
  assert.equal(machine.phys.read32(labels.get('counter')!), 1); // handler ran once
  assert.equal(machine.phys.read32(labels.get('marker')!), 0xbeef); // user resumed after IRET
});

// --- 2. page fault: a guest handler maps a missing page and retries -----------

test('guest kernel: a user page fault is handled in-CPU and the instruction retries', () => {
  // Paging on. Firmware (the host loader) builds the address space and the IDT;
  // the guest kernel installs the IDT base, and its page-fault handler makes the
  // missing page present then IRETs so the faulting LOAD re-executes and succeeds.
  const USER_VA = 0x40000; // user code virtual address
  const DATA_VA = 0x50000; // demand-paged data page
  const USER_PHYS = 0x20000;
  const DATA_PHYS = 0x21000;
  const PD = 0x10000;
  const IDT = 0x38000;
  const KSP = 0x30000;

  const kernel = assemble(`
    boot:
      MOV R1, ${IDT}
      LIDT R1
      MOV R1, ${KSP}
      LKSP R1
      ; enter user mode (paging already on)
      MOV R0, 0x60000         ; user sp (unused)
      PUSH R0
      MOV R0, 0               ; user flags
      PUSH R0
      MOV R0, 1               ; USER
      PUSH R0
      MOV R0, ${USER_VA}      ; user entry (virtual)
      PUSH R0
      IRET

    pf_handler:
      PUSH R5
      PUSH R6
      LOAD R6, pf_count
      INC R6
      STORE R6, pf_count      ; prove the handler ran (and how often)
      LOAD R5, fixup_addr     ; physical (=identity virtual) address of the PTE
      LOAD R6, fixup_val      ; the PTE value with Present set
      STORER R5, R6           ; make the missing page present
      POP R6
      POP R5
      IRET                    ; retry the faulting instruction

    sys_handler:
      HLT                     ; any syscall = stop the machine

    pf_count:   .word 0
    fixup_addr: .word 0
    fixup_val:  .word 0
  `);

  const user = assemble(
    `
      LOAD R0, ${DATA_VA}     ; reads a not-present page -> page fault, then retries
      INT 0x80                ; exit
    `,
    USER_VA,
  );

  const machine = new Machine({ physSize: 512 * 1024 });
  const phys = machine.phys;
  const mmu = machine.cpu.mmu;

  // Firmware: load images, build the page tables, populate the IDT.
  machine.load(0, kernel.bytes);
  machine.load(USER_PHYS, user.bytes);
  phys.write32(DATA_PHYS, 0x1234); // the value the user expects to read back

  phys.zeroPage(PD);
  let nextFrame = 0x11000;
  const alloc = () => {
    const f = nextFrame;
    nextFrame += 4096;
    return f;
  };
  // Identity-map the kernel region (code, stacks, IDT, page tables) as supervisor.
  for (let p = 0; p < 0x40000; p += 4096) mmu.map(PD, p, p, PTE.W, alloc);
  // User code (read/exec) and the demand page (mapped, then made not-present).
  mmu.map(PD, USER_VA, USER_PHYS, PTE.U, alloc);
  mmu.map(PD, DATA_VA, DATA_PHYS, PTE.U, alloc);

  // Find the demand page's PTE, clear Present, and hand the handler what it needs.
  const pde = phys.read32(PD + dirIndex(DATA_VA) * 4);
  const pteAddr = (pde & ADDR_MASK) + tableIndex(DATA_VA) * 4;
  const pte = phys.read32(pteAddr); // has Present set
  phys.write32(pteAddr, pte & ~PTE.P); // demand-fault on first access
  phys.write32(kernel.labels.get('fixup_addr')!, pteAddr);
  phys.write32(kernel.labels.get('fixup_val')!, pte);

  // IDT entries (physical): vector 14 = page fault, vector 0x80 = exit.
  installGate(phys, IDT, 14, kernel.labels.get('pf_handler')!);
  installGate(phys, IDT, 0x80, kernel.labels.get('sys_handler')!);

  machine.reset({ pc: 0, sp: 0x2f000, ptbr: PD, pagingEnabled: true });
  const r = machine.run(10000);

  assert.equal(r.reason, 'halt');
  assert.equal(machine.phys.read32(kernel.labels.get('pf_count')!), 1); // faulted once
  assert.equal(machine.cpu.regs[0], 0x1234); // the retried LOAD read the mapped page
});

// --- 3. timer: a user loop is preempted through the IRQ vector path -----------

test('guest kernel: a timer IRQ preempts a user loop with no TS scheduler', () => {
  // Paging off. The guest arms the in-CPU timer (IRQ0 -> vector 32); its handler
  // counts ticks and halts after three, proving timer-driven preemption.
  const { bytes, labels } = assemble(`
    boot:
      MOV R1, 0x8000
      LIDT R1
      MOV R2, 0x8100          ; &IDT[32]  (timer = IRQ0 -> vector 32)
      MOV R3, timer_handler
      STORER R2, R3
      MOV R2, 0x8104
      MOV R3, 1
      STORER R2, R3
      MOV R1, 0x5000
      LKSP R1
      MOV R1, 50              ; fire the timer every 50 instructions
      STMR R1
      ; drop to a user loop with interrupts enabled
      MOV R0, 0x4000
      PUSH R0
      MOV R0, ${IF}           ; user flags: IF set -> preemptible
      PUSH R0
      MOV R0, 1               ; USER
      PUSH R0
      MOV R0, user
      PUSH R0
      IRET

    user:
      LOAD R5, work
      INC R5
      STORE R5, work          ; make observable progress, forever
      JMP user

    timer_handler:
      PUSH R5
      PUSH R6
      LOAD R5, ticks
      INC R5
      STORE R5, ticks
      MOV R6, 3
      CMP R5, R6
      JZ timer_done           ; stop after three ticks
      POP R6
      POP R5
      IRET                    ; resume the preempted user loop
    timer_done:
      HLT

    ticks: .word 0
    work:  .word 0
  `);

  const machine = new Machine({ physSize: 64 * 1024 });
  machine.load(0, bytes);
  machine.reset();

  const r = machine.run(1_000_000);

  assert.equal(r.reason, 'halt');
  assert.equal(machine.phys.read32(labels.get('ticks')!), 3); // preempted three times
  assert.ok(machine.phys.read32(labels.get('work')!) > 0); // the user loop made progress
});

// --- mechanics: IRET round-trips the trap frame; double fault is reported -----

test('no IDT installed: a syscall still falls back to returning to the host', () => {
  const machine = new Machine({ physSize: 64 * 1024 });
  const { bytes } = assemble('MOV R0, 5\nINT 0x80\nHLT');
  machine.load(0, bytes);
  machine.reset(); // idtr stays 0 -> model-A behaviour

  const r = machine.run(100);
  assert.equal(r.reason, 'syscall');
  assert.equal(r.reason === 'syscall' && r.num, 0x80);
});

test('a fault during trap delivery (unmapped kernel stack) is reported as a double fault', () => {
  // Paging on, but the kernel stack page is left unmapped, so pushing the trap
  // frame itself faults. The CPU must report this rather than recursing.
  const PD = 0x10000;
  const IDT = 0x38000;
  const phys_size = 512 * 1024;

  const kernel = assemble(`
    boot:
      MOV R1, ${IDT}
      LIDT R1
      MOV R1, 0x70000         ; kernel stack pointer -> deliberately UNMAPPED
      LKSP R1
      MOV R0, 0x60000
      PUSH R0
      MOV R0, 0
      PUSH R0
      MOV R0, 1
      PUSH R0
      MOV R0, 0x40000
      PUSH R0
      IRET
    sys_handler:
      HLT
  `);
  const user = assemble('INT 0x80', 0x40000);

  const machine = new Machine({ physSize: phys_size });
  const phys = machine.phys;
  const mmu = machine.cpu.mmu;
  machine.load(0, kernel.bytes);
  machine.load(0x20000, user.bytes);
  phys.zeroPage(PD);
  let nextFrame = 0x11000;
  const alloc = () => {
    const f = nextFrame;
    nextFrame += 4096;
    return f;
  };
  for (let p = 0; p < 0x40000; p += 4096) mmu.map(PD, p, p, PTE.W, alloc);
  mmu.map(PD, 0x40000, 0x20000, PTE.U, alloc);
  installGate(phys, IDT, 0x80, kernel.labels.get('sys_handler')!);

  machine.reset({ pc: 0, sp: 0x2f000, ptbr: PD, pagingEnabled: true });
  const r = machine.run(10000);

  assert.equal(r.reason, 'fault');
  assert.equal(r.reason === 'fault' && /double fault/.test(r.message), true);
});

// Write an 8-byte IDT gate descriptor: [handler offset, Present].
function installGate(
  phys: { write32(a: number, v: number): void },
  base: number,
  vec: number,
  handler: number,
): void {
  phys.write32(base + vec * 8, handler);
  phys.write32(base + vec * 8 + 4, 1);
}
