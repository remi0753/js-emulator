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
} as const;
