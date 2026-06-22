// v2 Phase 8 demo: real in-CPU trap and interrupt entry (model B).
//
// NO TypeScript kernel: a guest kernel written in assembly installs an interrupt
// descriptor table, runs a user program in USER mode, services its INT 0x80
// syscalls in a handler, and is driven by a hardware timer IRQ that preempts the
// user loop — all in-CPU, returning to each handler's caller with IRET. The host
// only loads the image and presses "run".
//
// Watch the output: the user prints "Hi", then its busy loop is interrupted by
// timer ticks ('.') until the kernel has counted five and halts the machine.
//
// Run: node demo/v2-trap.ts

import { assemble } from '../src/assembler.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';

const IDT = 0x8000; // interrupt descriptor table (physical, paging off)
const KSP = 0x5000; // kernel stack top
const CON = PORT.CONSOLE_DATA;

const guest = assemble(`
  boot:
    MOV R1, ${IDT}
    LIDT R1                  ; install the IDT
    MOV R2, 0x8400           ; IDT[0x80] -> syscall handler
    MOV R3, sys_handler
    STORER R2, R3
    MOV R2, 0x8404
    MOV R3, 1
    STORER R2, R3
    MOV R2, 0x8100           ; IDT[32] -> timer handler (IRQ0)
    MOV R3, timer_handler
    STORER R2, R3
    MOV R2, 0x8104
    MOV R3, 1
    STORER R2, R3
    MOV R1, ${KSP}
    LKSP R1                  ; kernel stack for trap entry
    MOV R1, 30
    STMR R1                  ; timer: IRQ0 every 30 instructions
    ; enter user mode with interrupts enabled, via a synthetic IRET frame
    MOV R0, 0x4000
    PUSH R0
    MOV R0, 8                ; user flags: IF set (preemptible)
    PUSH R0
    MOV R0, 1                ; USER mode
    PUSH R0
    MOV R0, user
    PUSH R0
    IRET

  user:
    MOV R0, 'H'
    INT 0x80
    MOV R0, 'i'
    INT 0x80
    MOV R0, 10               ; newline
    INT 0x80
  spin:
    LOAD R5, work            ; spin forever; the timer will preempt us
    INC R5
    STORE R5, work
    JMP spin

  sys_handler:               ; print the char in R0 (R0 == 0 would exit)
    PUSH R6
    PUSH R7
    MOV R7, 0
    CMP R0, R7
    JZ sys_exit
    MOV R6, ${CON}
    OUT R6, R0
    POP R7
    POP R6
    IRET
  sys_exit:
    HLT

  timer_handler:             ; one '.' per tick; halt after five
    PUSH R5
    PUSH R6
    PUSH R7
    MOV R6, ${CON}
    MOV R7, '.'
    OUT R6, R7
    LOAD R5, ticks
    INC R5
    STORE R5, ticks
    MOV R7, 5
    CMP R5, R7
    JZ timer_done
    POP R7
    POP R6
    POP R5
    IRET
  timer_done:
    MOV R7, 10               ; newline
    OUT R6, R7
    HLT

  ticks: .word 0
  work:  .word 0
`);

const machine = new Machine({ physSize: 64 * 1024 });

console.log('=== v2 Phase 8: guest kernel handling its own traps and IRQs ===\n');
machine.load(0, guest.bytes);
machine.reset(); // KERNEL mode, paging off, pc = 0

const result = machine.run(1_000_000);

console.log(`\nmachine stopped: ${result.reason}`);
console.log(`timer ticks counted by the guest: ${machine.phys.read32(guest.labels.get('ticks')!)}`);
console.log(`user loop iterations: ${machine.phys.read32(guest.labels.get('work')!)}`);
