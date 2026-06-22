// v2 Phase 6 demo: pipes + blocking I/O.
//
// A guest program creates a pipe and forks. The child (producer) writes a message
// into the write end; the parent (consumer) reads from the read end and prints it.
// The consumer blocks until the producer writes — exactly the IPC a shell sets up
// for `producer | consumer`. Built on the pipe/dup syscalls and blocking reads.
//
// Run: node demo/v2-pipe.ts

import { assemble } from '../src/assembler.ts';
import { LAYOUT } from '../src/v2/kernel/abi.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';

const prog = assemble(
  `
      MOV R0, 10           ; PIPE(fds) -> fds[0]=read, fds[1]=write
      MOV R1, fds0
      INT 0x80
      MOV R0, 4            ; FORK
      INT 0x80
      MOV R7, 0
      CMP R0, R7
      JZ  producer
    consumer:
      LOAD R1, fds1        ; close the write end we don't use
      MOV  R0, 8
      INT  0x80
    c_read:
      LOAD R1, fds0        ; READ(readfd, buf, 16) — blocks until data/EOF
      MOV  R0, 9
      MOV  R2, buf
      MOV  R3, 16
      INT  0x80
      CMP  R0, R7
      JZ   c_done          ; EOF (producer closed)
      MOVR R3, R0
      MOV  R0, 1           ; WRITE(stdout, buf, n)
      MOV  R1, 1
      MOV  R2, buf
      INT  0x80
      JMP  c_read
    c_done:
      MOV  R0, 0
      MOV  R1, 0
      INT  0x80
    producer:
      LOAD R1, fds0        ; close the read end we don't use
      MOV  R0, 8
      INT  0x80
      LOAD R1, fds1        ; WRITE(writefd, msg, len)
      MOV  R0, 1
      MOV  R2, msg
      MOV  R3, 29
      INT  0x80
      LOAD R1, fds1        ; close write end -> consumer sees EOF
      MOV  R0, 8
      INT  0x80
      MOV  R0, 0
      MOV  R1, 0
      INT  0x80
    fds0:
      .word 0
    fds1:
      .word 0
    buf:
      .word 0,0,0,0
    msg:
      .string "piped through a kernel pipe!\\n"
  `,
  LAYOUT.USER_TEXT,
).bytes;

const kernel = new Kernel({ quantum: 100, log: (m) => console.log(`[kernel] ${m}`) });

console.log('=== v2 pipes + blocking I/O ===\n');
kernel.spawn('pipe', prog);
kernel.run();

console.log('\n=== done ===');
for (const p of kernel.processes.values()) {
  console.log(`  pid=${p.pid} name=${p.name} state=${p.state} exit=${p.exitCode}`);
}
