# System Calls

Syscalls are invoked with `INT 0x80` (Linux-style). The CPU returns to the OS
with `reason='int'`, and the OS reads the call number and arguments from
registers.

## ABI

| Register      | Role                                  |
|---------------|---------------------------------------|
| `R0`          | syscall number (in) / return value (out) |
| `R1`,`R2`,`R3`| arguments                             |

A typical call:

```asm
MOV  R0, 1      ; syscall number (WRITE)
MOV  R1, 'A'    ; argument
INT  0x80       ; trap into the kernel; R0 holds the return value afterwards
```

> Note: registers other than `R0` are not guaranteed to survive a syscall in the
> way you might expect from the program's view, because `R0` is overwritten with
> the return value. Keep loop counters and constants in a register you do not
> reuse as a syscall number (e.g. reserve `R7` for a zero constant in loops).

## Calls

| # | Name     | Args              | Effect                                         |
|---|----------|-------------------|------------------------------------------------|
| 0 | `EXIT`   | R1 = exit code    | terminate the process                          |
| 1 | `WRITE`  | R1 = char code    | write one character to the console; R0 = 0     |
| 2 | `YIELD`  | —                 | voluntarily give up the CPU (go to queue tail) |
| 3 | `GETPID` | —                 | R0 = this process's PID                        |
| 4 | `SPAWN`  | R1 = program ID   | create a new process; R0 = child PID (or -1)   |
| 5 | `SLEEP`  | R1 = ticks        | block for the given number of scheduler ticks  |

## Scheduling behavior

- `WRITE`, `YIELD`, `GETPID`, `SPAWN` are non-blocking: the process is put back on
  the **tail** of the ready queue, so other processes run before it resumes.
- `EXIT` removes the process from scheduling (its PCB is kept for inspection,
  with `state = 'terminated'` and the recorded `exitCode`).
- `SLEEP` moves the process to the sleeper set until `clock >= wakeAt`.
- An unknown syscall number returns `-1` in `R0` and does not block.
