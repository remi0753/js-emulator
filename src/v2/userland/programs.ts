// Userland programs (v2), written in assembly and run as guest bytecode in USER
// mode: `init`, a small shell, and a few coreutils. They use the syscall ABI
// (R0 = number, R1..R3 = args) and receive argc in R0 / argv pointer in R1 at
// entry. Until there is a C-like compiler (v3), userland is hand-written asm.
//
// Syscalls used: EXIT=0 WRITE=1 FORK=4 EXEC=5 WAIT=6 OPEN=7 CLOSE=8 READ=9.

import { assemble } from '../../assembler.ts';
import { LAYOUT } from '../kernel/abi.ts';
import type { Kernel } from '../kernel/kernel.ts';

// init: the first user process. Execs the shell; if that fails, exits non-zero.
const INIT = `
      MOV  R1, i_sh        ; path = "/bin/sh"
      MOV  R2, 0           ; no argv
      MOV  R0, 5           ; EXEC
      INT  0x80
      MOV  R0, 0           ; exec failed -> EXIT 1
      MOV  R1, 1
      INT  0x80
    i_sh:
      .string "/bin/sh"
`;

// A reusable "print NUL-terminated string at R3" routine. Requires R7 == 0.
// Clobbers R0/R1/R2 and advances R3 to the terminator.
const PUTS = `
    puts:
      LB   R0, R3          ; R0 = *R3
      CMP  R0, R7
      JZ   puts_done
      PUSH R3
      MOV  R0, 1           ; WRITE(1, R3, 1)
      MOV  R1, 1
      MOVR R2, R3
      MOV  R3, 1
      INT  0x80
      POP  R3
      INC  R3
      JMP  puts
    puts_done:
      RET
`;

// echo: print argv[1..] separated by spaces, then a newline.
const ECHO = `
      MOV  R7, 0
      MOVR R6, R1          ; argv
      MOVR R5, R0          ; argc
      MOV  R4, 1           ; i = 1
    e_loop:
      CMP  R4, R5
      JGE  e_nl            ; i >= argc -> finish
      MOVR R2, R4
      MOV  R1, 4
      MUL  R2, R1          ; R2 = i*4
      MOVR R1, R6
      ADD  R2, R1          ; R2 = &argv[i]
      LOADR R3, R2         ; R3 = argv[i]
      CALL puts
      MOVR R0, R4          ; trailing space unless last arg
      INC  R0
      CMP  R0, R5
      JGE  e_next
      MOV  R0, 1
      MOV  R1, 1
      MOV  R2, e_sp
      MOV  R3, 1
      INT  0x80
    e_next:
      INC  R4
      JMP  e_loop
    e_nl:
      MOV  R0, 1
      MOV  R1, 1
      MOV  R2, e_nlc
      MOV  R3, 1
      INT  0x80
      MOV  R0, 0
      MOV  R1, 0
      INT  0x80
${PUTS}
    e_sp:
      .string " "
    e_nlc:
      .string "\\n"
`;

// cat: copy each named file (or stdin when given no arguments) to stdout.
const CAT = `
      MOV  R7, 0
      MOVR R6, R1          ; argv
      MOVR R5, R0          ; argc
      MOV  R4, 2
      CMP  R5, R4
      JL   c_stdin         ; argc < 2 -> read stdin
      MOVR R2, R6
      MOV  R1, 4
      ADD  R2, R1
      LOADR R1, R2         ; path = argv[1]
      MOV  R0, 7           ; OPEN(path, O_RDONLY)
      MOV  R2, 0
      INT  0x80
      MOVR R5, R0          ; fd
      CMP  R5, R7
      JL   c_err           ; open failed
      JMP  c_read
    c_stdin:
      MOV  R5, 0           ; fd = stdin
    c_read:
      MOV  R0, 9           ; READ(fd, buf, 64)
      MOVR R1, R5
      MOV  R2, c_buf
      MOV  R3, 64
      INT  0x80
      CMP  R0, R7
      JZ   c_done          ; EOF
      MOVR R3, R0          ; nread
      MOV  R0, 1           ; WRITE(stdout, buf, nread)
      MOV  R1, 1
      MOV  R2, c_buf
      INT  0x80
      JMP  c_read
    c_done:
      MOV  R0, 8           ; CLOSE(fd)
      MOVR R1, R5
      INT  0x80
      MOV  R0, 0
      MOV  R1, 0
      INT  0x80
    c_err:
      MOV  R0, 0
      MOV  R1, 1
      INT  0x80
    c_buf:
      .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
`;

// ls: list a directory (default "/"). A directory is a readable file of 16-byte
// entries { inum:u16, name[14] }; print the name of each non-empty entry.
const LS = `
      MOV  R7, 0
      MOVR R6, R1          ; argv
      MOVR R5, R0          ; argc
      MOV  R4, 2
      CMP  R5, R4
      JL   l_root
      MOVR R2, R6
      MOV  R1, 4
      ADD  R2, R1
      LOADR R1, R2         ; path = argv[1]
      JMP  l_open
    l_root:
      MOV  R1, l_roots     ; default "/"
    l_open:
      MOV  R0, 7           ; OPEN(path, O_RDONLY)
      MOV  R2, 0
      INT  0x80
      MOVR R5, R0          ; fd
      CMP  R5, R7
      JL   l_err
    l_loop:
      MOV  R0, 9           ; READ(fd, ent, 16)
      MOVR R1, R5
      MOV  R2, l_ent
      MOV  R3, 16
      INT  0x80
      CMP  R0, R7
      JZ   l_done          ; EOF
      LOAD R0, l_ent       ; first word holds the u16 inum (low half)
      MOV  R1, 0xffff
      AND  R0, R1
      CMP  R0, R7
      JZ   l_loop          ; free slot -> skip
      MOV  R3, l_ent       ; name starts after the 2-byte inum
      MOV  R1, 2
      ADD  R3, R1
      CALL puts
      MOV  R0, 1           ; newline
      MOV  R1, 1
      MOV  R2, l_nl
      MOV  R3, 1
      INT  0x80
      JMP  l_loop
    l_done:
      MOV  R0, 8           ; CLOSE(fd)
      MOVR R1, R5
      INT  0x80
      MOV  R0, 0
      MOV  R1, 0
      INT  0x80
    l_err:
      MOV  R0, 0
      MOV  R1, 1
      INT  0x80
${PUTS}
    l_roots:
      .string "/"
    l_nl:
      .string "\\n"
    l_ent:
      .word 0,0,0,0
`;

// sh: a minimal shell. Prints a prompt, reads a line from stdin, splits it into
// argv on spaces, then fork/exec/waits the command. Quits on EOF.
const SH = `
      MOV  R7, 0
    sh_loop:
      MOV  R0, 1           ; print the prompt
      MOV  R1, 1
      MOV  R2, sh_prompt
      MOV  R3, 2
      INT  0x80
      MOV  R6, sh_line     ; R6 = where to store the next char
    sh_rc:
      MOV  R0, 9           ; READ one byte into [R6]
      MOV  R1, 0
      MOVR R2, R6
      MOV  R3, 1
      INT  0x80
      CMP  R0, R7
      JZ   sh_eof          ; read returned 0 -> EOF
      LB   R1, R6
      MOV  R2, 10          ; newline ends the line
      CMP  R1, R2
      JZ   sh_eol
      INC  R6
      JMP  sh_rc
    sh_eof:
      MOV  R0, sh_line
      CMP  R6, R0
      JZ   sh_exit         ; EOF on an empty line -> quit
    sh_eol:
      SB   R6, R7          ; NUL-terminate the line
      MOV  R5, sh_line     ; R5 = scan ptr
      MOV  R4, 0           ; R4 = argc
    sh_tok:
      LB   R0, R5          ; skip spaces
      CMP  R0, R7
      JZ   sh_run
      MOV  R1, 32
      CMP  R0, R1
      JNZ  sh_word
      INC  R5
      JMP  sh_tok
    sh_word:
      MOVR R2, R4          ; argv[argc] = R5
      MOV  R1, 4
      MUL  R2, R1
      MOV  R1, sh_argv
      ADD  R2, R1
      STORER R2, R5
      INC  R4
    sh_scan:
      LB   R0, R5          ; advance to end of token
      CMP  R0, R7
      JZ   sh_run
      MOV  R1, 32
      CMP  R0, R1
      JZ   sh_space
      INC  R5
      JMP  sh_scan
    sh_space:
      SB   R5, R7          ; terminate this token
      INC  R5
      JMP  sh_tok
    sh_run:
      MOVR R2, R4          ; argv[argc] = NULL
      MOV  R1, 4
      MUL  R2, R1
      MOV  R1, sh_argv
      ADD  R2, R1
      STORER R2, R7
      CMP  R4, R7
      JZ   sh_loop         ; blank line
      MOV  R0, 4           ; FORK
      INT  0x80
      CMP  R0, R7
      JZ   sh_child
      MOV  R0, 6           ; parent: WAIT for the command
      MOV  R1, 0
      INT  0x80
      JMP  sh_loop
    sh_child:
      ; resolve the command under /bin: sh_path = "/bin/" + argv[0]
      MOV  R3, sh_pfx
      MOV  R6, sh_path
    sh_cp1:
      LB   R0, R3
      CMP  R0, R7
      JZ   sh_cp2
      SB   R6, R0
      INC  R3
      INC  R6
      JMP  sh_cp1
    sh_cp2:
      LOAD R3, sh_argv     ; argv[0] (the command name)
    sh_cp3:
      LB   R0, R3
      SB   R6, R0
      CMP  R0, R7
      JZ   sh_exec
      INC  R3
      INC  R6
      JMP  sh_cp3
    sh_exec:
      MOV  R1, sh_path     ; path = "/bin/<cmd>"
      MOV  R2, sh_argv     ; argv vector
      MOV  R0, 5           ; EXEC
      INT  0x80
      MOV  R0, 1           ; exec failed
      MOV  R1, 1
      MOV  R2, sh_nf
      MOV  R3, 6
      INT  0x80
      MOV  R0, 0
      MOV  R1, 127
      INT  0x80
    sh_exit:
      MOV  R0, 0
      MOV  R1, 0
      INT  0x80
    sh_prompt:
      .string "$ "
    sh_pfx:
      .string "/bin/"
    sh_nf:
      .string "sh: ?\\n"
    sh_path:
      .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
    sh_line:
      .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
    sh_argv:
      .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
`;

// Path -> assembly source for the standard userland.
export const USERLAND: Record<string, string> = {
  '/bin/init': INIT,
  '/bin/sh': SH,
  '/bin/echo': ECHO,
  '/bin/cat': CAT,
  '/bin/ls': LS,
};

// Assemble each program at the user text address and install it into the kernel's
// filesystem so it can be exec()'d by path.
export function installUserland(kernel: Kernel): void {
  for (const [path, source] of Object.entries(USERLAND)) {
    kernel.install(path, assemble(source, LAYOUT.USER_TEXT).bytes);
  }
}
