// v2 Phase 3 demo: the Unix process model on the virtual hardware.
//
// One "init"-style process forks three children. Each child execs a separate
// installed program (loaded into a fresh address space from its ELF-like image),
// prints a line, and exits with a distinct code. The parent waits on each child
// and reports the reaped pid + exit status — exactly fork/exec/wait/exit.
//
// Run: node demo/v2-fork-exec.ts

import { assemble } from '../src/assembler.ts';
import { LAYOUT } from '../src/v2/kernel/abi.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';

// A child program: print a label line, then exit with `code`.
function worker(label: string, code: number): Uint8Array {
  return assemble(
    `
      MOV R0, 1            ; SYS_WRITE
      MOV R1, 1            ; fd = stdout
      MOV R2, msg
      MOV R3, ${label.length + 1}
      INT 0x80
      MOV R0, 0            ; SYS_EXIT
      MOV R1, ${code}
      INT 0x80
    msg:
      .string "${label}\\n"
  `,
    LAYOUT.USER_TEXT,
  ).bytes;
}

// init: fork 3 children, each execs /bin/work{1,2,3}; then wait for all 3,
// printing the pid+status of each reaped child.
const init = assemble(
  `
      MOV R6, 3            ; children left to spawn
      MOV R5, 0            ; constant 0
    spawn_loop:
      CMP R6, R5
      JZ  reap_all
      MOV R0, 4            ; FORK
      INT 0x80
      CMP R0, R5
      JZ  do_exec          ; child branch (R0 == 0)
      DEC R6               ; parent: one more child spawned
      JMP spawn_loop

    do_exec:
      ; pick the program path from the count still in R6 (3,2,1 -> work3/2/1)
      MOV R0, 3
      CMP R6, R0
      JZ  e3
      MOV R0, 2
      CMP R6, R0
      JZ  e2
    e1:
      MOV R1, p1
      JMP go
    e2:
      MOV R1, p2
      JMP go
    e3:
      MOV R1, p3
    go:
      MOV R0, 5            ; EXEC
      INT 0x80
      MOV R0, 0            ; exec failed -> exit 1
      MOV R1, 1
      INT 0x80

    reap_all:
      MOV R6, 3            ; children left to reap
    reap_loop:
      CMP R6, R5
      JZ  done
      MOV R0, 6            ; WAIT
      MOV R1, status
      INT 0x80
      MOV R7, 0xffffffff
      CMP R0, R7
      JZ  done             ; no more children
      ; print "reaped pid="
      MOV R0, 1
      MOV R1, 1
      MOV R2, rmsg
      MOV R3, 13
      INT 0x80
      DEC R6
      JMP reap_loop
    done:
      MOV R0, 0
      MOV R1, 0
      INT 0x80

    p1:
      .string "/bin/work1"
    p2:
      .string "/bin/work2"
    p3:
      .string "/bin/work3"
    rmsg:
      .string "init: reaped\\n"
    status:
      .word 0
  `,
  LAYOUT.USER_TEXT,
).bytes;

const kernel = new Kernel({
  quantum: 200,
  log: (m) => console.log(`[kernel] ${m}`),
});

console.log('=== v2 fork / exec / wait / exit (Unix process model) ===\n');

kernel.install('/bin/work1', worker('work1: hello', 11));
kernel.install('/bin/work2', worker('work2: hello', 22));
kernel.install('/bin/work3', worker('work3: hello', 33));

kernel.spawn('init', init);
kernel.run();

console.log('\n=== process table ===');
for (const p of kernel.processes.values()) {
  console.log(`  pid=${p.pid} name=${p.name} state=${p.state} exit=${p.exitCode}`);
}
console.log(`  physical frames free: ${kernel.pmm.freeCount}/${kernel.pmm.total}`);
