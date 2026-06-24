// v2 Phase 2 demo: user-mode processes on the real virtual hardware.
//
// Two guest programs run in USER mode with their own paging address spaces. They
// print via the WRITE syscall and are preempted by the timer (quantum), so their
// output interleaves — multitasking with genuine privilege separation and an MMU.
//
// Run: node demo/v2-preempt.ts

import { assemble } from '../src/assembler.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';
import { LAYOUT } from '../src/v2/layout.ts';

// Print `ch` three times, burning CPU between writes so the quantum expires.
function printer(ch: string): Uint8Array {
  return assemble(
    `
      MOV R7, 0
      MOV R6, 1
      MOV R5, 3
    outer:
      CMP R5, R7
      JZ  done
      MOV R4, 80          ; busy work
    inner:
      DEC R4
      CMP R4, R7
      JNZ inner
      MOV R0, 1           ; SYS_WRITE
      MOV R1, 1           ; fd = stdout
      MOV R2, ch
      MOV R3, 1
      INT 0x80
      SUB R5, R6
      JMP outer
    done:
      MOV R0, 0           ; SYS_EXIT
      MOV R1, 0
      INT 0x80
    ch:
      .string "${ch}"
  `,
    LAYOUT.USER_TEXT,
  ).bytes;
}

const kernel = new Kernel({
  quantum: 40, // small slice -> visible preemption
  log: (m) => console.log(`[kernel] ${m}`),
});

console.log('=== v2 user-mode preemptive multitasking (paging + traps) ===\n');
kernel.spawn('A', printer('A'));
kernel.spawn('B', printer('B'));
kernel.run();

console.log('\n\n=== done ===');
for (const p of kernel.processes.values()) {
  console.log(`  pid=${p.pid} name=${p.name} state=${p.state} exit=${p.exitCode}`);
}
console.log(`  physical frames free: ${kernel.pmm.freeCount}/${kernel.pmm.total}`);
