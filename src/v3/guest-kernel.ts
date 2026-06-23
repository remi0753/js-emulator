import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assemble } from '../assembler.ts';
import { FLAG, IDT_ENTRY_SIZE, IDT_PRESENT, SYSCALL_INT, TIMER_IRQ, TRAP } from '../isa.ts';
import { SYS } from '../v2/kernel/abi.ts';
import { compileC } from '../toolchain/c.ts';
import { type KernelImage, linkKernelImage } from '../toolchain/linker.ts';
import { MODE } from '../vm/custom32/cpu.ts';
import { PORT } from '../vm/custom32/platform.ts';

// The guest kernels are written in real source files under ./kernel/*.c. They
// stay a single source of truth for the memory layout and ISA constants by
// keeping those here and substituting them in: a kernel file references each
// value as a bare `CFG_NAME` token, and loadKernelSource() replaces every such
// token with the numeric literal (or generated initializer) defined here. This
// is a deliberately tiny preprocessor — no macros, no includes — enough to move
// the bulk of the kernel out of TypeScript string literals and into files with
// editor tooling, without giving up the TS-owned layout constants.

type Defines = Record<string, number | string>;

const kernelSource = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./kernel/${name}`, import.meta.url)), 'utf8');

function loadKernelSource(name: string, defines: Defines): string {
  let source = kernelSource(name);
  // Replace longest names first so no token is a prefix of another mid-edit.
  for (const key of Object.keys(defines).sort((a, b) => b.length - a.length)) {
    const value = defines[key]!;
    source = source.replace(new RegExp(`\\b${key}\\b`, 'g'), String(value));
  }
  const leftover = /\bCFG_[A-Z0-9_]+\b/.exec(source);
  if (leftover) {
    throw new Error(`guest kernel ${name}: unsubstituted config token ${leftover[0]}`);
  }
  return source;
}

// ---------------------------------------------------------------------------
// Phase 11: a minimal guest kernel that owns paging, page faults, the timer
// IRQ, and an idle loop. Source: ./kernel/phase11.c.
// ---------------------------------------------------------------------------

// Fixed physical addresses the Phase 11 kernel owns. Everything here lives inside
// the identity-mapped low region (0..512 KiB, see setup_paging) so the kernel can
// touch its own structures whether or not paging is on. The frame pool sits above
// the kernel image / IDT / page tables and below the hardware stack.
export const PHASE11_KERNEL_LAYOUT = {
  idt: 0x8000,
  pageDirectory: 0x10000,
  pageTable0: 0x11000,
  framePoolBase: 0x20000, // bump frame allocator: first frame handed out
  framePoolEnd: 0x40000, // one past the last usable frame
  demandVirtual: 0x90000, // a virtual page deliberately left unmapped (outside identity)
  stackTop: 0x70000,
} as const;

function phase11Defines(): Defines {
  const L = PHASE11_KERNEL_LAYOUT;
  return {
    CFG_CONSOLE_DATA: PORT.CONSOLE_DATA,
    CFG_FRAME_POOL_BASE: L.framePoolBase,
    CFG_FRAME_POOL_END: L.framePoolEnd,
    CFG_IDT: L.idt,
    CFG_IDT_ENTRY_SIZE: IDT_ENTRY_SIZE,
    CFG_IDT_PRESENT: IDT_PRESENT,
    CFG_PAGE_TABLE0: L.pageTable0,
    CFG_PAGE_DIRECTORY: L.pageDirectory,
    CFG_TIMER_VECTOR: TRAP.IRQ_BASE + TIMER_IRQ,
    CFG_PAGEFAULT_VECTOR: TRAP.PAGEFAULT,
    CFG_STACK_TOP: L.stackTop,
    CFG_DEMAND_VIRTUAL: L.demandVirtual,
  };
}

export const PHASE11_GUEST_KERNEL_SOURCE = loadKernelSource('phase11.c', phase11Defines());

export function buildPhase11KernelImage(): KernelImage {
  return linkKernelImage([
    compileC(PHASE11_GUEST_KERNEL_SOURCE, {
      start: 'kernel',
      cStackSize: 8192,
      moduleId: 'phase11',
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Phase 12: memory management + scheduling inside the guest. The kernel runs a
// free-list PMM, per-process address spaces, fork without COW, user-mode entry,
// and a timer-driven round-robin scheduler. Source: ./kernel/phase12.c.
// ---------------------------------------------------------------------------

const PTE_KERNEL = 3; // present + writable (no user bit): kernel-only page
const PTE_USER = 7; // present + writable + user-accessible: user page
const PAGE_BYTES = 4096;
const PHASE12_MAX_PROC = 8;

export const PHASE12_FORK_SENTINEL = 0x1234abcd;

export const PHASE12_KERNEL_LAYOUT = {
  // Kernel structures, all inside the identity-mapped low region (0..4 MiB) so
  // the kernel keeps the same addresses no matter which page directory is live.
  idt: 0x40000,
  kernelPageTable: 0x41000, // identity-maps the low 4 MiB; shared by every address space
  kstackTop: 0x50000, // hardware kernel stack (esp0) used on USER->KERNEL traps
  framePoolBase: 0x100000, // free-list frame allocator: first usable frame
  framePoolEnd: 0x380000, // one past the last usable frame
  // Per-process user virtual layout (page-directory entry 1, the 4..8 MiB range).
  userCode: 0x400000,
  userData: 0x401000,
  userStackPage: 0x40f000,
  userStackTop: 0x410000,
  // Boot/run knobs. The period must comfortably exceed the cost of one trip
  // through the timer handler (save/switch/restore, a few hundred instructions);
  // otherwise the next IRQ is already pending on IRET and the user never runs.
  timerPeriod: 8000, // in-CPU timer IRQ every N instructions
  physSize: 0x400000, // 4 MiB of physical RAM (covers the identity map + pool)
} as const;

// The user program every process runs: bump a counter and stamp its fork tag,
// both at fixed user virtual addresses, forever. Two processes touching the
// same virtual addresses but landing in different physical frames proves the
// address spaces are isolated; both counters advancing proves both were
// scheduled by the timer. R0 holds the per-process tag at entry (the kernel
// seeds it like a fork return value). It is assembled here and injected into
// the kernel source as a char-array initializer.
const PHASE12_USER_PROGRAM = `
  MOVR R2, R0            ; R2 = tag (seeded by the kernel in the initial context)
  MOV R3, 0              ; R3 = loop counter
uloop:
  INC R3
  STORE R3, ${PHASE12_KERNEL_LAYOUT.userData}
  STORE R2, ${PHASE12_KERNEL_LAYOUT.userData + 4}
  JMP uloop
`;

function phase12Defines(): Defines {
  const L = PHASE12_KERNEL_LAYOUT;
  const userBytes = assemble(PHASE12_USER_PROGRAM, L.userCode).bytes;
  if (userBytes.length > PAGE_BYTES) {
    throw new Error(
      `Phase 12 user program is ${userBytes.length} bytes, but the loader maps one ${PAGE_BYTES}-byte code page`,
    );
  }
  return {
    CFG_CONSOLE_DATA: PORT.CONSOLE_DATA,
    CFG_PTE_KERNEL: PTE_KERNEL,
    CFG_PTE_USER: PTE_USER,
    CFG_MAX_PROC: PHASE12_MAX_PROC,
    CFG_PROC_REG_COUNT: PHASE12_MAX_PROC * 8,
    CFG_FRAME_POOL_BASE: L.framePoolBase,
    CFG_FRAME_POOL_END: L.framePoolEnd,
    CFG_KERNEL_PT: L.kernelPageTable,
    CFG_USER_CODE: L.userCode,
    CFG_USER_DATA: L.userData,
    CFG_USER_STACK_PAGE: L.userStackPage,
    CFG_USER_STACK_TOP: L.userStackTop,
    CFG_IDT: L.idt,
    CFG_IDT_ENTRY_SIZE: IDT_ENTRY_SIZE,
    CFG_IDT_PRESENT: IDT_PRESENT,
    CFG_TIMER_VECTOR: TRAP.IRQ_BASE + TIMER_IRQ,
    CFG_PAGEFAULT_VECTOR: TRAP.PAGEFAULT,
    CFG_KSTACK_TOP: L.kstackTop,
    CFG_TIMER_PERIOD: L.timerPeriod,
    CFG_FLAG_IF: FLAG.IF,
    CFG_MODE_USER: MODE.USER,
    CFG_FORK_SENTINEL: PHASE12_FORK_SENTINEL,
    CFG_USER_PROGRAM_LEN: userBytes.length,
    CFG_USER_PROGRAM_BYTES: `{${Array.from(userBytes).join(', ')}}`,
  };
}

export const PHASE12_GUEST_KERNEL_SOURCE = loadKernelSource('phase12.c', phase12Defines());

export function buildPhase12KernelImage(): KernelImage {
  const image = linkKernelImage([
    compileC(PHASE12_GUEST_KERNEL_SOURCE, {
      start: 'kernel',
      cStackSize: 8192,
      moduleId: 'phase12',
    }),
  ]);
  if (image.flat.length > PHASE12_KERNEL_LAYOUT.idt) {
    throw new Error(
      `Phase 12 kernel image overlaps reserved IDT/page-table region: image end 0x${image.flat.length.toString(16)}, IDT 0x${PHASE12_KERNEL_LAYOUT.idt.toString(16)}`,
    );
  }
  return image;
}

// ---------------------------------------------------------------------------
// Phase 13: syscalls + process lifecycle inside the guest. The kernel handles
// the INT 0x80 syscall ABI (exit/write/read/yield/getpid/fork/exec/wait) and a
// runnable/zombie/blocked process lifecycle entirely in guest code; TypeScript
// only delivers the trap. Source: ./kernel/phase13.c.
// ---------------------------------------------------------------------------

// Process states (kept here so the kernel source reads with named CFG_ST_*
// tokens rather than bare integers).
const PHASE13_STATE = {
  unused: 0,
  runnable: 1,
  zombie: 2,
  blocked: 3,
} as const;

// The Phase 13 layout reuses Phase 12's; only the kbd port and user-range
// bounds (for safe copies out of user memory) are added.
export const PHASE13_KERNEL_LAYOUT = PHASE12_KERNEL_LAYOUT;

// Replace a JS newline with the assembler's `\n` escape so a message stays on a
// single .string line (assemble() splits the source on real newlines first).
const asmString = (s: string): string => s.replace(/\n/g, '\\n');

// init (program 0): print a banner, fork a child, wait for it, then print and
// exit. The child branch execs program 1. Exercises getpid/write/fork/wait/
// exec/exit. fork's return is tested with CMP/JZ because IRET restores the
// user's flags rather than setting them from R0.
const PHASE13_INIT_MSG = 'init: start\n';
const PHASE13_DONE_MSG = 'init: child exited\n';
const PHASE13_PROG0 = `
  MOV R0, ${SYS.GETPID}
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.WRITE}
  MOV R1, 1
  MOV R2, m_start
  MOV R3, ${PHASE13_INIT_MSG.length}
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.FORK}
  INT ${SYSCALL_INT}
  MOV R7, 0
  CMP R0, R7
  JZ child_branch
parent_branch:
  MOV R0, ${SYS.WAIT}
  MOV R1, 0
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.WRITE}
  MOV R1, 1
  MOV R2, m_done
  MOV R3, ${PHASE13_DONE_MSG.length}
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.EXIT}
  MOV R1, 0
  INT ${SYSCALL_INT}
child_branch:
  MOV R0, ${SYS.EXEC}
  MOV R1, 1
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.EXIT}
  MOV R1, 1
  INT ${SYSCALL_INT}
m_start:
  .string "${asmString(PHASE13_INIT_MSG)}"
m_done:
  .string "${asmString(PHASE13_DONE_MSG)}"
`;

// child (program 1): print a line and exit with a distinctive code.
export const PHASE13_CHILD_EXIT_CODE = 7;
const PHASE13_CHILD_MSG = 'child: hello\n';
const PHASE13_PROG1 = `
  MOV R0, ${SYS.WRITE}
  MOV R1, 1
  MOV R2, c_msg
  MOV R3, ${PHASE13_CHILD_MSG.length}
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.EXIT}
  MOV R1, ${PHASE13_CHILD_EXIT_CODE}
  INT ${SYSCALL_INT}
c_msg:
  .string "${asmString(PHASE13_CHILD_MSG)}"
`;

export const PHASE13_EXPECTED_OUTPUT =
  'phase13: boot\n' +
  'phase13: enter user\n' +
  PHASE13_INIT_MSG +
  PHASE13_CHILD_MSG +
  PHASE13_DONE_MSG +
  'phase13: all processes exited\n';

function phase13UserProgram(name: string, source: string): { len: number; bytes: string } {
  const { bytes } = assemble(source, PHASE13_KERNEL_LAYOUT.userCode);
  if (bytes.length > PAGE_BYTES) {
    throw new Error(
      `Phase 13 program ${name} is ${bytes.length} bytes, but the loader maps one ${PAGE_BYTES}-byte code page`,
    );
  }
  return { len: bytes.length, bytes: `{${Array.from(bytes).join(', ')}}` };
}

function phase13Defines(): Defines {
  const L = PHASE13_KERNEL_LAYOUT;
  const prog0 = phase13UserProgram('init', PHASE13_PROG0);
  const prog1 = phase13UserProgram('child', PHASE13_PROG1);
  return {
    CFG_CONSOLE_DATA: PORT.CONSOLE_DATA,
    CFG_KBD_DATA: PORT.KBD_DATA,
    CFG_PTE_KERNEL: PTE_KERNEL,
    CFG_PTE_USER: PTE_USER,
    CFG_MAX_PROC: PHASE12_MAX_PROC,
    CFG_PROC_REG_COUNT: PHASE12_MAX_PROC * 8,
    CFG_FRAME_POOL_BASE: L.framePoolBase,
    CFG_FRAME_POOL_END: L.framePoolEnd,
    CFG_KERNEL_PT: L.kernelPageTable,
    CFG_USER_CODE: L.userCode,
    CFG_USER_DATA: L.userData,
    CFG_USER_STACK_PAGE: L.userStackPage,
    CFG_USER_STACK_TOP: L.userStackTop,
    CFG_USER_BASE: L.userCode,
    CFG_USER_END: L.userStackTop,
    CFG_IDT: L.idt,
    CFG_IDT_ENTRY_SIZE: IDT_ENTRY_SIZE,
    CFG_IDT_PRESENT: IDT_PRESENT,
    CFG_TIMER_VECTOR: TRAP.IRQ_BASE + TIMER_IRQ,
    CFG_PAGEFAULT_VECTOR: TRAP.PAGEFAULT,
    CFG_SYSCALL_VECTOR: SYSCALL_INT,
    CFG_KSTACK_TOP: L.kstackTop,
    CFG_TIMER_PERIOD: L.timerPeriod,
    CFG_FLAG_IF: FLAG.IF,
    CFG_MODE_USER: MODE.USER,
    CFG_ST_UNUSED: PHASE13_STATE.unused,
    CFG_ST_RUNNABLE: PHASE13_STATE.runnable,
    CFG_ST_ZOMBIE: PHASE13_STATE.zombie,
    CFG_ST_BLOCKED: PHASE13_STATE.blocked,
    CFG_SYS_EXIT: SYS.EXIT,
    CFG_SYS_WRITE: SYS.WRITE,
    CFG_SYS_READ: SYS.READ,
    CFG_SYS_YIELD: SYS.YIELD,
    CFG_SYS_GETPID: SYS.GETPID,
    CFG_SYS_FORK: SYS.FORK,
    CFG_SYS_EXEC: SYS.EXEC,
    CFG_SYS_WAIT: SYS.WAIT,
    CFG_PROG0_LEN: prog0.len,
    CFG_PROG0_BYTES: prog0.bytes,
    CFG_PROG1_LEN: prog1.len,
    CFG_PROG1_BYTES: prog1.bytes,
  };
}

export const PHASE13_GUEST_KERNEL_SOURCE = loadKernelSource('phase13.c', phase13Defines());

export function buildPhase13KernelImage(): KernelImage {
  const image = linkKernelImage([
    compileC(PHASE13_GUEST_KERNEL_SOURCE, {
      start: 'kernel',
      cStackSize: 8192,
      moduleId: 'phase13',
    }),
  ]);
  if (image.flat.length > PHASE13_KERNEL_LAYOUT.idt) {
    throw new Error(
      `Phase 13 kernel image overlaps reserved IDT/page-table region: image end 0x${image.flat.length.toString(16)}, IDT 0x${PHASE13_KERNEL_LAYOUT.idt.toString(16)}`,
    );
  }
  return image;
}
