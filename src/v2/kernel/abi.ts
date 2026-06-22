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
} as const;

// File descriptors wired up in Phase 2 (real fd table comes with the FS).
export const FD = { STDIN: 0, STDOUT: 1, STDERR: 2 } as const;

// Device port numbers on the port bus.
export const PORT = {
  CONSOLE_DATA: 0x3f8, // write a byte here to emit one character (COM1-ish)
} as const;

// Per-process user virtual address space layout.
export const LAYOUT = {
  USER_TEXT: 0x1000, // program image is loaded here (page 0 left unmapped = null guard)
  USER_STACK_TOP: 0x10000, // stack grows down from here
  USER_STACK_PAGES: 4,
} as const;
