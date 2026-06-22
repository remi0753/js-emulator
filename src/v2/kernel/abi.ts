// Kernel ABI and layout constants (v2).

import { SYSCALL_INT } from '../../isa.ts';

export { SYSCALL_INT };

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
} as const;

// File descriptors wired up in Phase 2 (real fd table comes with the FS).
export const FD = { STDIN: 0, STDOUT: 1, STDERR: 2 } as const;

// Device port numbers on the port bus.
export const PORT = {
  CONSOLE_DATA: 0x3f8, // write a byte here to emit one character (COM1-ish)
  DISK_DATA: 0x1f0, // read/write one 32-bit word at the disk position; auto-advances
  DISK_POS: 0x1f2, // set the disk access position (in sectors)
  DISK_SECTORS: 0x1f7, // read: number of sectors on the disk
  KBD_DATA: 0x60, // read: next input byte from the keyboard (0 if empty)
} as const;

// open() flags (R2 of the OPEN syscall).
export const O = {
  RDONLY: 0x000,
  WRONLY: 0x001,
  RDWR: 0x002,
  CREATE: 0x200,
  TRUNC: 0x400,
} as const;

// Per-process user virtual address space layout.
export const LAYOUT = {
  USER_TEXT: 0x1000, // program image is loaded here (page 0 left unmapped = null guard)
  USER_STACK_TOP: 0x10000, // stack grows down from here
  USER_STACK_PAGES: 4,
} as const;
