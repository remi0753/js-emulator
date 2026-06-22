# System Calls

Syscalls are invoked with `INT 0x80` (Linux-style). The CPU returns to the kernel
and the kernel reads the call number and arguments from registers.

## ABI

| Register      | Role                                      |
|---------------|-------------------------------------------|
| `R0`          | syscall number (in) / return value (out)  |
| `R1`,`R2`,`R3`| arguments                                 |

A typical call:

```asm
MOV  R0, 1      ; syscall number (WRITE)
MOV  R1, 1      ; fd
MOV  R2, buf    ; pointer
MOV  R3, len    ; length
INT  0x80       ; trap into the kernel; R0 holds the return value afterwards
```

> Note: registers other than `R0` are not guaranteed to survive a syscall the way
> you might expect from the program's view, because `R0` is overwritten with the
> return value. Keep loop counters and constants in a register you do not reuse as
> a syscall number (e.g. reserve `R7` for a zero constant in loops).

## v2 calls

These are the numbers defined in [`src/v2/kernel/abi.ts`](../src/v2/kernel/abi.ts).
Pointers are **user virtual addresses**; the kernel reaches them through the MMU
(`copyin`/`copyout`), so a bad pointer returns `-1` instead of crashing.

| # | Name     | Args                          | Effect                                                       |
|---|----------|-------------------------------|-------------------------------------------------------------|
| 0 | `EXIT`   | R1 = exit code                | terminate; address space freed, PCB lingers as a zombie     |
| 1 | `WRITE`  | R1 = fd, R2 = buf, R3 = len   | write `len` bytes from user space to the console; R0 = len  |
| 2 | `YIELD`  | —                             | give up the CPU (go to the ready-queue tail)                |
| 3 | `GETPID` | —                             | R0 = this process's PID                                     |
| 4 | `FORK`   | —                             | duplicate the process; R0 = child pid (parent) / 0 (child)  |
| 5 | `EXEC`   | R1 = path ptr, R2 = argv ptr  | replace the image with the executable at `path`, passing `argv`; -1 on error |
| 6 | `WAIT`   | R1 = status ptr (0 = ignore)  | reap a child; R0 = child pid (status written to ptr), -1 if none |
| 7 | `OPEN`   | R1 = path ptr, R2 = flags     | open/create a file; R0 = fd / -1                            |
| 8 | `CLOSE`  | R1 = fd                       | close a descriptor; R0 = 0 / -1                            |
| 9 | `READ`   | R1 = fd, R2 = buf, R3 = len   | read into user space; R0 = bytes read (0 = EOF) / -1       |

`WRITE` (call 1) writes to any writable fd: the console (fd 1/2) or a file opened
for writing. `open` flags (`O.*` in abi.ts): `RDONLY=0`, `WRONLY=1`, `RDWR=2`,
`CREATE=0x200`, `TRUNC=0x400` (OR them together).

### Files & descriptors (Phase 4)

- The kernel mounts an xv6-style filesystem on the block disk (`src/v2/kernel/fs.ts`).
  `open` resolves an absolute path to an inode (creating the file with `O.CREATE`),
  and installs an entry in the per-process fd table; `read`/`write` advance the
  open file's offset.
- Directories are ordinary readable files: `read` on a directory fd returns raw
  16-byte entries `{ inum:u16, name[14] }` (this is how a future `ls` lists files).
- `fork` shares open files with the child (reference-counted); `exec` keeps them
  open; `exit` closes them all.
- `exec` reads the executable's bytes from the filesystem and loads its segments,
  so programs are launched straight off the disk.

### Arguments & stdin (Phase 5)

- `exec` takes an `argv` vector (R2): a user array of string pointers terminated by
  NULL. The kernel copies the strings onto the new program's stack and starts it
  with **argc in R0** and the **argv pointer in R1**. R2 = 0 means no arguments.
- `read` on stdin (fd 0) returns characters previously queued with the kernel's
  `feedInput` (the live keyboard arrives in Phase 6); an empty queue reads as 0
  (EOF), which is how the shell knows to quit.

### Process model (Phase 3)

- `FORK` copies the parent's whole address space (page directory, page tables, and
  every mapped frame). Both processes resume just after the `INT`; they differ
  only in `R0`. Copy-on-write is a later optimization (Phase 6).
- `EXEC` loads an installed program — an ELF-like executable (see
  [v2.md](v2.md#executable-format) and `src/v2/kernel/exec.ts`) — into a fresh
  address space, frees the old one, and restarts at the entry point. On success it
  does not return (the new image runs); on failure it returns `-1` to the caller.
- `WAIT` reaps one zombie child, returning its pid and writing its exit code to
  `*status`. If the caller has running children but none have exited it **blocks**
  (state `waiting`) until one does; with no children at all it returns `-1`.
- `EXIT` frees the process's address space immediately and marks it a zombie,
  reparenting any surviving children to `init` (pid 1) and waking a parent that is
  blocked in `wait`.

## Scheduling behavior

- `WRITE`, `READ`, `OPEN`, `CLOSE`, `YIELD`, `GETPID`, `FORK`, and a
  failed/returning `EXEC` are non-blocking: the process goes back on the **tail**
  of the ready queue.
- `WAIT` blocks the caller until a child becomes reapable (unless one already is,
  or there are no children).
- `EXIT` removes the process from scheduling; its PCB is kept (`state = 'zombie'`,
  recorded `exitCode`) until a `wait` reaps it.
- An unknown syscall number returns `-1` in `R0` and does not block.

## v1 calls

The v1 kernel ([`src/v1/os.ts`](../src/v1/os.ts)) has a simpler surface on a flat
memory model: `EXIT`, `WRITE` (R1 = char code), `YIELD`, `GETPID`,
`SPAWN` (R1 = program id), and `SLEEP` (R1 = ticks). See [v1.md](v1.md).
