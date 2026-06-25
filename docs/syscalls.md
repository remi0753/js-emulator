# System Calls

Syscalls are invoked with `INT 0x80` (Linux-style). The CPU returns to the kernel
and the kernel reads the call number and arguments from registers.

The maintained guest kernel in `src/v3/kernel/` returns stable negative Linux
errno numbers from the raw syscall ABI (for example `-ENOENT == -2` and
`-EFAULT == -14`). Its libc wrappers translate any negative result to `-1` and
store the positive error number in the global `errno`. In particular, guest
`exec` distinguishes a missing path (`ENOENT`), an invalid executable
(`ENOEXEC`), an oversized argument vector (`E2BIG`), and insufficient memory
(`ENOMEM`). A caught signal that interrupts a blocking syscall produces
`EINTR`.

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

These are the numbers defined in [`src/abi.ts`](../src/abi.ts).
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
| 9 | `READ`   | R1 = fd, R2 = buf, R3 = len   | read into user space; R0 = bytes read (0 = EOF) / -1; **blocks** on stdin/pipe |
| 10| `PIPE`   | R1 = int[2] ptr               | create a pipe; writes [readfd, writefd]; R0 = 0 / -1       |
| 11| `DUP`    | R1 = fd                       | duplicate fd to the lowest free fd; R0 = new fd / -1       |
| 12| `UPTIME` | —                             | R0 = scheduler ticks since boot                            |
| 13| `TIME` | — | current RTC Unix timestamp |
| 14| `SHUTDOWN` | — | power off the virtual machine |
| 15| `KILL` | R1 = pid selector, R2 = signal | signal a process or process group |
| 16| `SIGACTION` | R1 = signal, R2 = action, R3 = old action | install/query a signal action |
| 17| `SIGPROCMASK` | R1 = how, R2 = mask, R3 = old mask | change the blocked-signal mask |
| 18| `SIGRETURN` | — | restore the context saved for a caught signal |
| 19| `WAITPID` | R1 = pid selector, R2 = status, R3 = options | wait for exit/stop/continue |
| 20| `SETPGID` | R1 = pid, R2 = pgid | create or join a process group |
| 21| `SETSID` | — | create a session and become its process-group leader |
| 22| `TCSETPGRP` | R1 = pgid | set the terminal foreground process group |
| 23| `TCGETPGRP` | — | return the terminal foreground process group |
| 24| `GETPPID` | — | return the parent pid (`0` for init) |
| 25| `NANOSLEEP` | R1 = request, R2 = remaining | sleep for a `timespec`; interruptible by signals |
| 26| `BRK` | R1 = new break (`0` queries) | query or change the process heap end |
| 27| `MMAP` | R1 = `mmap_args` pointer | create a private anonymous or file-backed mapping |
| 28| `MUNMAP` | R1 = address, R2 = length | remove pages and update/split VM areas |
| 29| `MPROTECT` | R1 = address, R2 = length, R3 = protection | change user/read-write accessibility |
| 30| `FCNTL` | R1 = fd, R2 = command, R3 = argument | duplicate/query/control a descriptor |
| 31| `IOCTL` | R1 = fd, R2 = request, R3 = argument | terminal foreground-group requests |
| 32| `GETTIMEOFDAY` | R1 = timeval, R2 = timezone | realtime seconds and microseconds |
| 33| `CLOCK_GETTIME` | R1 = clock id, R2 = timespec | realtime or monotonic guest time |
| 34| `UNAME` | R1 = utsname | return guest system identity |
| 35| `GETDENTS` | R1 = fd, R2 = dirent buffer, R3 = bytes | read Linux-shaped directory records |
| 36| `STAT` | R1 = path, R2 = stat buffer | metadata, following the final symlink |
| 37| `FSTAT` | R1 = fd, R2 = stat buffer | metadata for an open file |
| 38| `LSTAT` | R1 = path, R2 = stat buffer | metadata without following the final symlink |
| 39| `CHMOD` | R1 = path, R2 = mode | change permission bits |
| 40| `CHOWN` | R1 = path, R2 = uid, R3 = gid | change ownership (`-1` preserves a field) |
| 41| `MKDIR` | R1 = path, R2 = mode | create a directory |
| 42| `RMDIR` | R1 = path | remove an empty directory |
| 43| `UNLINK` | R1 = path | remove a non-directory link |
| 44| `LINK` | R1 = old path, R2 = new path | create a hard link |
| 45| `RENAME` | R1 = old path, R2 = new path | rename/move a filesystem object |
| 46| `SYMLINK` | R1 = target, R2 = link path | create a symbolic link |
| 47| `READLINK` | R1 = path, R2 = buffer, R3 = bytes | read a symlink target without a NUL terminator |
| 48| `LSEEK` | R1 = fd, R2 = offset, R3 = whence | change a shared open-file offset |
| 49| `GETUID` | — | return uid (0 in the single-user model) |
| 50| `GETGID` | — | return gid (0 in the single-user model) |

## Linux compatibility table

| Surface | Status | Notes |
|---------|--------|-------|
| negative errno / libc `errno` | implemented | raw `-errno`; wrappers return `-1` |
| `getpid`, `getppid`, `fork`, `exec`, `waitpid`, `exit` | implemented | guest-owned process lifecycle |
| signals and process groups | implemented subset | Phase 17 signal/job-control model |
| `nanosleep` | implemented | tick-resolution, signal-interruptible, reports remaining time |
| `brk`, `sbrk` | implemented | lazy zero-filled heap pages; shrinking releases resident pages |
| anonymous private `mmap` | implemented | lazy allocation; `fork` uses copy-on-write |
| private file-backed `mmap` | implemented | demand paging through the page cache; writes are COW |
| shared file-backed `mmap` | implemented | shared cached frames with dirty write-back |
| `munmap`, `mprotect` | implemented | page-granular VMA split/trim; works before or after faults |
| `fcntl` | implemented subset | `F_DUPFD`, `F_GETFD`, `F_SETFD`, `F_GETFL`; nonblocking deferred |
| `ioctl` | implemented subset | foreground groups, termios modes, and terminal window size |
| `gettimeofday`, `clock_gettime`, `uname` | implemented | 32-bit time values on this ISA |
| `getdents` | implemented | fixed 32-byte guest `dirent` records |
| inode metadata and credentials | implemented | persistent mode/uid/gid/nlink and 32-bit timestamps; single-user uid/gid 0 |
| `stat`, `fstat`, `lstat`, `chmod`, `chown` | implemented | stable 13-field custom32 `stat` layout |
| `mkdir`, `rmdir`, `unlink`, `link`, `rename` | implemented | persistent directory and hard-link mutation |
| `symlink`, `readlink` | implemented | relative/absolute traversal, bounded to eight expansions |
| `lseek` | implemented | `SEEK_SET`, `SEEK_CUR`, `SEEK_END`; shared by dup/fork |
| VFS mounts and pseudo filesystems | implemented | disk root plus devfs `/dev`, procfs `/proc`, and tmpfs `/tmp` |
| stack guard page | implemented | the page below the fixed user stack is never allocated |
| `O_NONBLOCK`, polling ioctls | unsupported | planned with the polling phase |
| Linux binary ABI compatibility | intentionally unsupported | programs are compiled for custom32 |

### Signals and job control (Phase 17)

- Signals 1–31 use bit masks (`1 << signal`). Implemented default semantics
  include `SIGINT` (2), `SIGKILL` (9), `SIGTERM` (15), `SIGCHLD` (17),
  `SIGCONT` (18), `SIGSTOP` (19), and `SIGTSTP` (20).
- `SIGKILL` and `SIGSTOP` cannot be caught or blocked. Caught handlers execute
  through libc's dispatcher and return through a `SIGRETURN` restorer.
- `kill(pid, sig)` follows Unix-style selectors: positive pid, `0` for the
  caller's process group, `< -1` for process group `-pid`, and `-1` for all
  processes.
- `waitpid` supports `WNOHANG=1`, `WUNTRACED=2`, and `WCONTINUED=4`. Exit status
  uses the conventional high-byte exit code; signaled exits use the low signal
  bits, stopped status has low byte `0x7f`, and continued status is `0xffff`.
- `/dev/tty` is the standard terminal device; `/dev/console` reaches the same
  line discipline while the serial port remains available for early kernel
  output. Canonical mode provides line buffering, erase/kill editing, echo,
  Ctrl-D EOF, Ctrl-C `SIGINT`, and Ctrl-Z `SIGTSTP`; raw mode exposes bytes as
  they arrive. `TCGETS`/`TCSETS*`, `TIOCGWINSZ`/`TIOCSWINSZ`, and foreground
  process-group ioctls are implemented.
- The TTY converts Ctrl-C into `SIGINT` for its foreground process group. The
  shell gives each command/pipeline a process group, transfers foreground
  ownership while waiting, and supports a trailing `&` for background jobs.

`WRITE` (call 1) writes to any writable fd: the console (fd 1/2) or a file opened
for writing. `open` flags (`O.*` in abi.ts): `RDONLY=0`, `WRONLY=1`, `RDWR=2`,
`CREATE=0x200`, `TRUNC=0x400` (OR them together).

### Files & descriptors (Phase 4)

- The kernel mounts an xv6-style filesystem on the block disk (`src/storage/fs.ts`).
  `open` resolves an absolute path to an inode (creating the file with `O.CREATE`),
  and installs an entry in the per-process fd table; `read`/`write` advance the
  open file's offset.
- Directories remain readable as raw on-disk entries for compatibility, while
  normal userland uses `getdents` and its stable 32-byte guest `dirent` records.
- `fork` shares open files with the child (reference-counted); `exec` keeps them
  open; `exit` closes them all. `dup` and `fork` refer to the same open-file
  description, so they share the current file offset.
- `exec` reads the executable's bytes from the filesystem and loads its segments,
  so programs are launched straight off the disk.

### Metadata and mutation (Phase 19)

- On-disk inodes store type/mode, uid/gid, link count, size, and 32-bit
  atime/mtime/ctime values. Regular files default to `0644`, directories to
  `0755`, symlinks to `0777`, and installed `/bin` programs to `0755`.
- This is filesystem format version 2. The superblock records the version and
  inode size; images using the earlier 64-byte inode layout must be rebuilt.
- The initial credential model is deliberately single-user: processes start as
  uid/gid 0 and children inherit those credentials. The permission-checking
  machinery and persistent ownership fields are present so a later multi-user
  phase does not require an ABI or disk-format redesign.
- The root filesystem is mounted read/write. Its internal mount-flags field
  supports a read-only bit, and every mutating filesystem path rejects writes
  when that bit is active.
- `unlink` keeps an inode alive while an open-file description still references
  it. Hard links share inode metadata and data; directory link counts and `..`
  are maintained across create, remove, and cross-directory rename.
- `lseek` changes the offset in the shared open-file description, so descriptors
  inherited through `fork` or created through `dup` observe the same position.

### VFS and pseudo filesystems (Phase 20)

- A guest-owned mount table routes absolute paths to the persistent disk root,
  devfs at `/dev`, procfs at `/proc`, or tmpfs at `/tmp`.
- Disk files, pseudo files, and device nodes resolve to a common vnode carrying
  filesystem-specific operations. Open descriptors retain the existing shared
  open-file-description offset and reference-count semantics.
- `/dev/console` is readable/writable and backs standard input/output/error;
  `/dev/null` discards writes and returns EOF; `/dev/zero` supplies zero bytes.
- `/proc/self` resolves to the calling process, `/proc/<pid>` exposes live
  process directories, and each directory has a dynamic `status` file.
- `/tmp` is a bounded in-memory filesystem. Its files support ordinary
  create/read/write/stat/seek/unlink operations and disappear on reboot.

### Arguments & stdin (Phase 5)

- `exec` takes an `argv` vector (R2): a user array of string pointers terminated by
  NULL. The kernel copies the strings onto the new program's stack and starts it
  with **argc in R0** and the **argv pointer in R1**. R2 = 0 means no arguments.

### Blocking I/O, pipes & COW fork (Phase 6)

- `read` on **stdin** blocks the process until a key is pressed (the keyboard
  device raises an interrupt that wakes blocked readers); at end-of-input it
  returns 0 (EOF). `read` on a **pipe** blocks until a writer provides data, or
  returns 0 once every write end is closed.
- `pipe` returns a read fd and a write fd over an in-kernel byte FIFO; `dup`
  duplicates a descriptor (both used to wire `cmd1 | cmd2`). `fork` shares pipe
  ends with the child (reference-counted), so a pipe stays open until *all* of its
  ends close.
- `fork` is **copy-on-write**: parent and child share their pages read-only and a
  page is copied only when one side writes to it (resolved by a page-fault
  handler), so forking is cheap and memory is shared until modified.
- The scheduler's `run()` returns when no process is ready; processes blocked on
  input stay parked until the host feeds the keyboard (`feedInput`) and calls
  `run()` again — exactly how a CPU idles until the next interrupt.

### Process model (Phase 3)

- `FORK` copies the parent's whole address space (page directory, page tables, and
  every mapped frame). Both processes resume just after the `INT`; they differ
  only in `R0`. Copy-on-write is a later optimization (Phase 6).
- `EXEC` loads an installed program — an ELF-like executable (see
  [v2.md](v2.md#executable-format) and `src/formats/executable.ts`) — into a fresh
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
