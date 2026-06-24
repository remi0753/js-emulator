// Stable userspace/kernel ABI shared by the TypeScript and guest kernels.

// syscall numbers (passed in R0; return value comes back in R0).
// Args are in R1, R2, R3. Invoked with `INT 0x80`.
export const SYS = {
  EXIT: 0, // R1 = exit code
  WRITE: 1, // R1 = fd, R2 = buf (user vaddr), R3 = len -> R0 = bytes written
  YIELD: 2, // give up the CPU
  GETPID: 3, // -> R0 = pid
  FORK: 4, // duplicate the process -> R0 = child pid (parent) / 0 (child) / -1 (error)
  EXEC: 5, // R1 = path (user vaddr, NUL-terminated) -> replaces the image; -1 on error
  WAIT: 6, // R1 = status ptr (user vaddr, 0 = ignore) -> R0 = reaped child pid / -1
  OPEN: 7, // R1 = path, R2 = flags (see O.*) -> R0 = fd / -1
  CLOSE: 8, // R1 = fd -> R0 = 0 / -1
  READ: 9, // R1 = fd, R2 = buf, R3 = len -> R0 = bytes read (0 = EOF) / -1
  PIPE: 10, // R1 = int[2] ptr (filled with [readfd, writefd]) -> R0 = 0 / -1
  DUP: 11, // R1 = fd -> R0 = new fd (lowest free) / -1
  UPTIME: 12, // -> R0 = scheduler ticks since boot
  TIME: 13, // -> R0 = current wall-clock time (Unix seconds) from the RTC device
  SHUTDOWN: 14, // power the machine off cleanly (does not return)
  KILL: 15, // R1 = pid/process-group selector, R2 = signal -> R0 = 0 / -1
  SIGACTION: 16, // R1 = signal, R2 = action ptr, R3 = old-action ptr
  SIGPROCMASK: 17, // R1 = how, R2 = mask, R3 = old-mask ptr
  SIGRETURN: 18, // restore the context saved by signal delivery
  WAITPID: 19, // R1 = pid selector, R2 = status ptr, R3 = options
  SETPGID: 20, // R1 = pid (0 = self), R2 = pgid (0 = pid)
  SETSID: 21, // create a session and process group -> session id
  TCSETPGRP: 22, // R1 = foreground process group
  TCGETPGRP: 23, // -> foreground process group
  GETPPID: 24, // -> R0 = parent pid (0 for init)
  NANOSLEEP: 25, // R1 = timespec request, R2 = remaining timespec
  BRK: 26, // R1 = new program break (0 queries) -> current/new break
  MMAP: 27, // R1 = pointer to mmap_args -> mapped address / -errno
  MUNMAP: 28, // R1 = address, R2 = length
  MPROTECT: 29, // R1 = address, R2 = length, R3 = PROT_*
  FCNTL: 30, // R1 = fd, R2 = command, R3 = argument
  IOCTL: 31, // R1 = fd, R2 = request, R3 = argument pointer/value
  GETTIMEOFDAY: 32, // R1 = timeval pointer, R2 = timezone (must be 0)
  CLOCK_GETTIME: 33, // R1 = clock id, R2 = timespec pointer
  UNAME: 34, // R1 = utsname pointer
  GETDENTS: 35, // R1 = directory fd, R2 = buffer, R3 = byte count
  STAT: 36, // R1 = path, R2 = stat pointer
  FSTAT: 37, // R1 = fd, R2 = stat pointer
  LSTAT: 38, // R1 = path, R2 = stat pointer (do not follow final symlink)
  CHMOD: 39, // R1 = path, R2 = mode
  CHOWN: 40, // R1 = path, R2 = uid, R3 = gid
  MKDIR: 41, // R1 = path, R2 = mode
  RMDIR: 42, // R1 = path
  UNLINK: 43, // R1 = path
  LINK: 44, // R1 = old path, R2 = new path
  RENAME: 45, // R1 = old path, R2 = new path
  SYMLINK: 46, // R1 = target, R2 = link path
  READLINK: 47, // R1 = path, R2 = buffer, R3 = size
  LSEEK: 48, // R1 = fd, R2 = offset, R3 = whence
  GETUID: 49, // -> R0 = real/effective uid (single-user first pass)
  GETGID: 50, // -> R0 = real/effective gid (single-user first pass)
} as const;

// File descriptors wired up in Phase 2 (real fd table comes with the FS).
export const FD = { STDIN: 0, STDOUT: 1, STDERR: 2 } as const;

// open() flags (R2 of the OPEN syscall).
export const O = {
  RDONLY: 0x000,
  WRONLY: 0x001,
  RDWR: 0x002,
  CREATE: 0x200,
  TRUNC: 0x400,
  NONBLOCK: 0x800,
} as const;

export const PROT = { NONE: 0, READ: 1, WRITE: 2, EXEC: 4 } as const;
export const MAP = { SHARED: 0x01, PRIVATE: 0x02, FIXED: 0x10, ANONYMOUS: 0x20 } as const;
export const FCNTL = {
  DUPFD: 0,
  GETFD: 1,
  SETFD: 2,
  GETFL: 3,
  SETFL: 4,
  FD_CLOEXEC: 1,
} as const;
export const IOCTL = { TIOCGPGRP: 0x540f, TIOCSPGRP: 0x5410 } as const;
export const CLOCK = { REALTIME: 0, MONOTONIC: 1 } as const;
export const SEEK = { SET: 0, CUR: 1, END: 2 } as const;
