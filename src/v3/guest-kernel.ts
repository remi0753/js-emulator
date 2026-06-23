import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assemble } from '../assembler.ts';
import { ARG_SIZE, FLAG, IDT_ENTRY_SIZE, IDT_PRESENT, SYSCALL_INT, TIMER_IRQ, TRAP } from '../isa.ts';
import { SYS } from '../v2/kernel/abi.ts';
import { BOOT_MAGIC, encodeBootBlock, makeBootBlock } from '../v2/kernel/bootblock.ts';
import { BlockDriver } from '../v2/kernel/disk.ts';
import { DIRSIZ, Fs, FSMAGIC, NDIRECT, ROOTINO, T_DIR, T_FILE } from '../v2/kernel/fs.ts';
import { compileC } from '../toolchain/c.ts';
import { type KernelImage, linkExecutable, linkKernelImage } from '../toolchain/linker.ts';
import { MODE } from '../vm/custom32/cpu.ts';
import { BlockDisk, SECTOR_SIZE } from '../vm/custom32/devices/disk.ts';
import { POWER_OFF } from '../vm/custom32/devices/power.ts';
import { PORT } from '../vm/custom32/platform.ts';
import { PortBus } from '../vm/custom32/ports.ts';

// The guest kernels are written in real source files under ./kernel/*.c. They
// stay a single source of truth for the memory layout and ISA constants by
// keeping those here and substituting them in: a kernel file references each
// value as a bare `CFG_NAME` token, and loadKernelSource() replaces every such
// token with the numeric literal (or generated initializer) defined here. This
// is a deliberately tiny preprocessor — no macros, no includes — enough to move
// the bulk of the kernel out of TypeScript string literals and into files with
// editor tooling, without giving up the TS-owned layout constants.

type Defines = Record<string, number | string>;

const sourceFile = (subpath: string): string =>
  readFileSync(fileURLToPath(new URL(`./${subpath}`, import.meta.url)), 'utf8');

// Substitute every CFG_* token in a source file with its defined literal,
// failing loudly on any leftover token (a typo or a missing define).
function substituteDefines(source: string, defines: Defines, label: string): string {
  // Replace longest names first so no token is a prefix of another mid-edit.
  for (const key of Object.keys(defines).sort((a, b) => b.length - a.length)) {
    const value = defines[key]!;
    source = source.replace(new RegExp(`\\b${key}\\b`, 'g'), String(value));
  }
  const leftover = /\bCFG_[A-Z0-9_]+\b/.exec(source);
  if (leftover) {
    throw new Error(`guest source ${label}: unsubstituted config token ${leftover[0]}`);
  }
  return source;
}

function loadKernelSource(name: string, defines: Defines): string {
  return substituteDefines(sourceFile(`kernel/${name}`), defines, name);
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

// ---------------------------------------------------------------------------
// Phase 14: storage + filesystem inside the guest. The kernel drives the block
// disk over the port bus, caches blocks, mounts the on-disk FS, resolves paths,
// reads files, exposes per-process file descriptors (open/read/close), and
// loads executables from the filesystem -- including init at boot. TypeScript
// only models the disk device and delivers traps. Source: ./kernel/phase14.c.
// ---------------------------------------------------------------------------

const PHASE14_NBUF = 16; // buffer-cache slots
const PHASE14_NFD = 16; // open files per process

// On-disk dinode size and inodes-per-block mirror the private layout in
// src/v2/kernel/fs.ts (DINODE_SIZE / IPB); the FS block size is the sector size.
const PHASE14_DINODE_SIZE = 64;
const PHASE14_IPB = SECTOR_SIZE / PHASE14_DINODE_SIZE;

export const PHASE14_KERNEL_LAYOUT = PHASE12_KERNEL_LAYOUT;

// Files written into the Phase 14 disk image. init reads and prints /etc/motd,
// then forks a child that execs /bin/hello; /bin/hello prints and exits.
const PHASE14_INIT_PATH = '/bin/init';
export const PHASE14_MOTD = 'welcome to jscpu-os phase 14\n';
const PHASE14_HELLO_MSG = 'hello from /bin/hello\n';
const PHASE14_DONE_MSG = 'init: done\n';
export const PHASE14_HELLO_EXIT_CODE = 0;

// init (program at /bin/init): open + read + print /etc/motd through file
// descriptors, then fork a child that execs /bin/hello, wait for it, and exit.
// The 64-byte read scratch lives in the user data page (CFG_USER_DATA).
const PHASE14_INIT_PROG = `
  MOV R0, ${SYS.OPEN}
  MOV R1, path_motd
  MOV R2, 0
  INT ${SYSCALL_INT}
  MOVR R6, R0              ; R6 = fd
mread:
  MOV R0, ${SYS.READ}
  MOVR R1, R6
  MOV R2, ${PHASE12_KERNEL_LAYOUT.userData}
  MOV R3, 64
  INT ${SYSCALL_INT}
  MOV R7, 0
  CMP R0, R7
  JZ mclose
  MOVR R4, R0             ; R4 = bytes read (WRITE clobbers R0)
  MOV R0, ${SYS.WRITE}
  MOV R1, 1
  MOV R2, ${PHASE12_KERNEL_LAYOUT.userData}
  MOVR R3, R4
  INT ${SYSCALL_INT}
  JMP mread
mclose:
  MOV R0, ${SYS.CLOSE}
  MOVR R1, R6
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.FORK}
  INT ${SYSCALL_INT}
  MOV R7, 0
  CMP R0, R7
  JZ do_child
parent_branch:
  MOV R0, ${SYS.WAIT}
  MOV R1, 0
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.WRITE}
  MOV R1, 1
  MOV R2, m_done
  MOV R3, ${PHASE14_DONE_MSG.length}
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.EXIT}
  MOV R1, 0
  INT ${SYSCALL_INT}
do_child:
  MOV R0, ${SYS.EXEC}
  MOV R1, path_hello
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.EXIT}
  MOV R1, 1
  INT ${SYSCALL_INT}
path_motd:
  .string "/etc/motd"
path_hello:
  .string "/bin/hello"
m_done:
  .string "${PHASE14_DONE_MSG.replace(/\n/g, '\\n')}"
`;

// /bin/hello: print a line and exit cleanly.
const PHASE14_HELLO_PROG = `
  MOV R0, ${SYS.WRITE}
  MOV R1, 1
  MOV R2, hmsg
  MOV R3, ${PHASE14_HELLO_MSG.length}
  INT ${SYSCALL_INT}
  MOV R0, ${SYS.EXIT}
  MOV R1, ${PHASE14_HELLO_EXIT_CODE}
  INT ${SYSCALL_INT}
hmsg:
  .string "${PHASE14_HELLO_MSG.replace(/\n/g, '\\n')}"
`;

export const PHASE14_EXPECTED_OUTPUT =
  'phase14: boot\n' +
  `phase14: exec ${PHASE14_INIT_PATH}\n` +
  PHASE14_MOTD +
  PHASE14_HELLO_MSG +
  PHASE14_DONE_MSG +
  'phase14: all processes exited\n';

function phase14Assemble(name: string, source: string): Uint8Array {
  const { bytes } = assemble(source, PHASE14_KERNEL_LAYOUT.userCode);
  if (bytes.length > PAGE_BYTES) {
    throw new Error(
      `Phase 14 program ${name} is ${bytes.length} bytes, but the loader maps one ${PAGE_BYTES}-byte code page`,
    );
  }
  return bytes;
}

// Build a bootable Phase 14 disk image with a formatted FS, the compiled-down
// userland (flat assembled programs), a seed file, and a boot manifest. The
// guest kernel reads this image back through the disk ports.
export function buildPhase14DiskImage(): Uint8Array {
  const disk = BlockDisk.blank(512); // 512 * 512 = 256 KiB
  const ports = new PortBus();
  ports.register(PORT.DISK_DATA, 1, disk);
  ports.register(PORT.DISK_POS, 1, disk);
  ports.register(PORT.DISK_SECTORS, 1, disk);

  const driver = new BlockDriver(ports);
  const fs = new Fs(driver);
  fs.mkfs();
  fs.writeFile(PHASE14_INIT_PATH, phase14Assemble('init', PHASE14_INIT_PROG));
  fs.writeFile('/bin/hello', phase14Assemble('hello', PHASE14_HELLO_PROG));
  fs.writeFile('/etc/motd', new TextEncoder().encode(PHASE14_MOTD));

  // The FS reserves sector 0; write the boot manifest there last (block 0).
  driver.write(0, encodeBootBlock(makeBootBlock(PHASE14_INIT_PATH)));
  return disk.data;
}

function phase14Defines(): Defines {
  const L = PHASE14_KERNEL_LAYOUT;
  return {
    CFG_CONSOLE_DATA: PORT.CONSOLE_DATA,
    CFG_KBD_DATA: PORT.KBD_DATA,
    CFG_DISK_POS: PORT.DISK_POS,
    CFG_DISK_DATA: PORT.DISK_DATA,
    CFG_PTE_KERNEL: PTE_KERNEL,
    CFG_PTE_USER: PTE_USER,
    CFG_MAX_PROC: PHASE12_MAX_PROC,
    CFG_PROC_REG_COUNT: PHASE12_MAX_PROC * 8,
    CFG_NFD: PHASE14_NFD,
    CFG_FD_TABLE_LEN: PHASE12_MAX_PROC * PHASE14_NFD,
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
    CFG_SYS_OPEN: SYS.OPEN,
    CFG_SYS_CLOSE: SYS.CLOSE,
    CFG_NBUF: PHASE14_NBUF,
    CFG_BUF_DATA_LEN: PHASE14_NBUF * SECTOR_SIZE,
    CFG_INITPATH_LEN: 64,
    CFG_FS_MAGIC: FSMAGIC,
    CFG_BOOT_MAGIC: BOOT_MAGIC,
    CFG_IPB: PHASE14_IPB,
    CFG_DINODE_SIZE: PHASE14_DINODE_SIZE,
    CFG_NDIRECT: NDIRECT,
    CFG_DIRSIZ: DIRSIZ,
    CFG_ROOTINO: ROOTINO,
    CFG_T_FILE: T_FILE,
  };
}

export const PHASE14_GUEST_KERNEL_SOURCE = loadKernelSource('phase14.c', phase14Defines());

export function buildPhase14KernelImage(): KernelImage {
  const image = linkKernelImage([
    compileC(PHASE14_GUEST_KERNEL_SOURCE, {
      start: 'kernel',
      cStackSize: 8192,
      moduleId: 'phase14',
    }),
  ]);
  if (image.flat.length > PHASE14_KERNEL_LAYOUT.idt) {
    throw new Error(
      `Phase 14 kernel image overlaps reserved IDT/page-table region: image end 0x${image.flat.length.toString(16)}, IDT 0x${PHASE14_KERNEL_LAYOUT.idt.toString(16)}`,
    );
  }
  return image;
}

// ---------------------------------------------------------------------------
// Phase 15: a compiled userland on the guest OS. The kernel gains executable
// loading (header + multi-page image), argv passing, a unified file-descriptor
// table, and pipe/dup; the userland (init, sh, echo, cat, ls) is compiled C
// linked against a small libc and installed on the disk image. Sources:
// ./kernel/phase15.c and ./userland/*.c.
// ---------------------------------------------------------------------------

const PHASE15_NFD = 16; // open files per process
const PHASE15_NPIPE = 8; // concurrent pipes
const PHASE15_PIPESZ = 512; // bytes buffered per pipe
const PHASE15_MAXARG = 16; // argv entries copied by exec
const PHASE15_ARGBUF = 512; // bytes of argv strings staged by exec
const PHASE15_DINODE_SIZE = 64;
const PHASE15_IPB = SECTOR_SIZE / PHASE15_DINODE_SIZE;

// 'PX15' little-endian: the guest executable header magic (magic, entry, memSize).
const PHASE15_EXEC_MAGIC = 0x35315850;

// User virtual layout for compiled programs: the image loads contiguously from
// USER_LOAD_BASE (text, then data+bss across as many pages as needed); a
// separate stack page sits at the top of the user range and carries argv.
export const PHASE15_KERNEL_LAYOUT = {
  ...PHASE12_KERNEL_LAYOUT,
  userLoadBase: 0x400000, // program image base (page-directory entry 1)
  userStackPage: 0x7ff000, // hardware/argv stack page
  userStackTop: 0x800000, // top of the user stack (exclusive)
  userBase: 0x400000, // syscall buffer bound-check: low
  userEnd: 0x800000, // syscall buffer bound-check: high (exclusive)
} as const;

export const PHASE15_MOTD = 'welcome to jscpu-os phase 15\n';

// Syscall numbers shared between the libc and the kernel.
function phase15SyscallDefines(): Defines {
  return {
    CFG_SYS_EXIT: SYS.EXIT,
    CFG_SYS_WRITE: SYS.WRITE,
    CFG_SYS_READ: SYS.READ,
    CFG_SYS_YIELD: SYS.YIELD,
    CFG_SYS_GETPID: SYS.GETPID,
    CFG_SYS_FORK: SYS.FORK,
    CFG_SYS_EXEC: SYS.EXEC,
    CFG_SYS_WAIT: SYS.WAIT,
    CFG_SYS_OPEN: SYS.OPEN,
    CFG_SYS_CLOSE: SYS.CLOSE,
    CFG_SYS_PIPE: SYS.PIPE,
    CFG_SYS_DUP: SYS.DUP,
    // Phase 16 device syscalls; the libc wrappers compile in every phase, but
    // only the Phase 16 kernel implements them.
    CFG_SYS_TIME: SYS.TIME,
    CFG_SYS_SHUTDOWN: SYS.SHUTDOWN,
  };
}

const PHASE15_LIBC_SOURCE = substituteDefines(
  sourceFile('userland/libc.c'),
  phase15SyscallDefines(),
  'libc.c',
);

// Compile and link a userland C program against the libc into a flat guest
// executable: a 12-byte header (magic, entry, memSize) followed by the text+data
// image. The kernel maps memSize bytes of pages from USER_LOAD_BASE, copies the
// image in, and the bss tail stays zero.
function buildUserExecutable(name: string, programSource: string): Uint8Array {
  const base = PHASE15_KERNEL_LAYOUT.userLoadBase;
  const libc = compileC(PHASE15_LIBC_SOURCE, { start: 'none', moduleId: `${name}_libc` });
  const prog = compileC(programSource, { start: 'user', moduleId: name, cStackSize: 4096 });
  const linked = linkExecutable([prog, libc], { textOrigin: base });

  const [textSeg, dataSeg] = linked.executable.segments;
  if (!textSeg || !dataSeg) throw new Error(`buildUserExecutable: ${name} missing segments`);
  const fileImageLen = dataSeg.vaddr - base + dataSeg.data.length;
  const memSize = dataSeg.vaddr - base + dataSeg.memSize; // includes the bss tail
  const image = new Uint8Array(fileImageLen);
  image.set(textSeg.data, textSeg.vaddr - base);
  image.set(dataSeg.data, dataSeg.vaddr - base);

  const out = new Uint8Array(12 + fileImageLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, PHASE15_EXEC_MAGIC, true);
  dv.setUint32(4, linked.entry, true);
  dv.setUint32(8, memSize, true);
  out.set(image, 12);
  return out;
}

// Build a bootable Phase 15 disk image: a formatted FS with the compiled
// userland installed under /bin, a seed /etc/motd, and a boot manifest naming
// /bin/init.
export function buildPhase15DiskImage(): Uint8Array {
  const disk = BlockDisk.blank(1024); // 1024 * 512 = 512 KiB
  const ports = new PortBus();
  ports.register(PORT.DISK_DATA, 1, disk);
  ports.register(PORT.DISK_POS, 1, disk);
  ports.register(PORT.DISK_SECTORS, 1, disk);

  const driver = new BlockDriver(ports);
  const fs = new Fs(driver);
  fs.mkfs();
  fs.writeFile('/bin/init', buildUserExecutable('init', sourceFile('userland/init.c')));
  fs.writeFile('/bin/sh', buildUserExecutable('sh', sourceFile('userland/sh.c')));
  fs.writeFile('/bin/echo', buildUserExecutable('echo', sourceFile('userland/echo.c')));
  fs.writeFile('/bin/cat', buildUserExecutable('cat', sourceFile('userland/cat.c')));
  fs.writeFile('/bin/ls', buildUserExecutable('ls', sourceFile('userland/ls.c')));
  fs.writeFile('/etc/motd', new TextEncoder().encode(PHASE15_MOTD));

  driver.write(0, encodeBootBlock(makeBootBlock('/bin/init')));
  return disk.data;
}

function phase15Defines(): Defines {
  const L = PHASE15_KERNEL_LAYOUT;
  return {
    ...phase15SyscallDefines(),
    CFG_CONSOLE_DATA: PORT.CONSOLE_DATA,
    CFG_KBD_DATA: PORT.KBD_DATA,
    CFG_DISK_POS: PORT.DISK_POS,
    CFG_DISK_DATA: PORT.DISK_DATA,
    CFG_PTE_KERNEL: PTE_KERNEL,
    CFG_PTE_USER: PTE_USER,
    CFG_MAX_PROC: PHASE12_MAX_PROC,
    CFG_PROC_REG_COUNT: PHASE12_MAX_PROC * 8,
    CFG_NFD: PHASE15_NFD,
    CFG_FD_TABLE_LEN: PHASE12_MAX_PROC * PHASE15_NFD,
    CFG_NPIPE: PHASE15_NPIPE,
    CFG_PIPESZ: PHASE15_PIPESZ,
    CFG_PIPE_BUF_LEN: PHASE15_NPIPE * PHASE15_PIPESZ,
    CFG_MAXARG: PHASE15_MAXARG,
    CFG_ARGBUF_LEN: PHASE15_ARGBUF,
    CFG_FRAME_POOL_BASE: L.framePoolBase,
    CFG_FRAME_POOL_END: L.framePoolEnd,
    CFG_KERNEL_PT: L.kernelPageTable,
    CFG_USER_LOAD_BASE: L.userLoadBase,
    CFG_USER_STACK_PAGE: L.userStackPage,
    CFG_USER_STACK_TOP: L.userStackTop,
    CFG_USER_BASE: L.userBase,
    CFG_USER_END: L.userEnd,
    CFG_IDT: L.idt,
    CFG_IDT_ENTRY_SIZE: IDT_ENTRY_SIZE,
    CFG_IDT_PRESENT: IDT_PRESENT,
    CFG_TIMER_VECTOR: TRAP.IRQ_BASE + TIMER_IRQ,
    CFG_PAGEFAULT_VECTOR: TRAP.PAGEFAULT,
    CFG_SYSCALL_VECTOR: SYSCALL_INT,
    CFG_SYSCALL_INSTR_SIZE: 1 + ARG_SIZE.imm, // INT imm: opcode + 4-byte immediate
    CFG_KSTACK_TOP: L.kstackTop,
    CFG_TIMER_PERIOD: L.timerPeriod,
    CFG_FLAG_IF: FLAG.IF,
    CFG_MODE_USER: MODE.USER,
    CFG_ST_UNUSED: PHASE13_STATE.unused,
    CFG_ST_RUNNABLE: PHASE13_STATE.runnable,
    CFG_ST_ZOMBIE: PHASE13_STATE.zombie,
    CFG_ST_BLOCKED: PHASE13_STATE.blocked,
    CFG_ST_PIPEWAIT: PHASE15_PIPEWAIT,
    CFG_FT_NONE: PHASE15_FT.none,
    CFG_FT_CONS: PHASE15_FT.console,
    CFG_FT_KBD: PHASE15_FT.keyboard,
    CFG_FT_FILE: PHASE15_FT.file,
    CFG_FT_PIPE: PHASE15_FT.pipe,
    CFG_NBUF: PHASE14_NBUF,
    CFG_BUF_DATA_LEN: PHASE14_NBUF * SECTOR_SIZE,
    CFG_INITPATH_LEN: 64,
    CFG_FS_MAGIC: FSMAGIC,
    CFG_BOOT_MAGIC: BOOT_MAGIC,
    CFG_EXEC_MAGIC: PHASE15_EXEC_MAGIC,
    CFG_IPB: PHASE15_IPB,
    CFG_DINODE_SIZE: PHASE15_DINODE_SIZE,
    CFG_NDIRECT: NDIRECT,
    CFG_DIRSIZ: DIRSIZ,
    CFG_ROOTINO: ROOTINO,
    CFG_T_FILE: T_FILE,
    CFG_T_DIR: T_DIR,
  };
}

// Process states reuse Phase 13's plus a pipe-wait state; fd types are local.
const PHASE15_PIPEWAIT = 4;
const PHASE15_FT = { none: 0, console: 1, keyboard: 2, file: 3, pipe: 4 } as const;

export const PHASE15_GUEST_KERNEL_SOURCE = loadKernelSource('phase15.c', phase15Defines());

export function buildPhase15KernelImage(): KernelImage {
  const image = linkKernelImage([
    compileC(PHASE15_GUEST_KERNEL_SOURCE, {
      start: 'kernel',
      cStackSize: 8192,
      moduleId: 'phase15',
    }),
  ]);
  if (image.flat.length > PHASE15_KERNEL_LAYOUT.idt) {
    throw new Error(
      `Phase 15 kernel image overlaps reserved IDT/page-table region: image end 0x${image.flat.length.toString(16)}, IDT 0x${PHASE15_KERNEL_LAYOUT.idt.toString(16)}`,
    );
  }
  return image;
}

// ---------------------------------------------------------------------------
// Phase 16: expand devices behind stable guest drivers. The kernel gains two
// device drivers -- an RTC read driver (the time() syscall) and a power-off
// write driver (the shutdown() syscall) -- and the userland gains /bin/date and
// /bin/shutdown that exercise them. Everything else carries over from Phase 15.
// Sources: ./kernel/phase16.c and ./userland/*.c.
// ---------------------------------------------------------------------------

// Same virtual-memory and boot layout as Phase 15; only new device ports are
// added on top.
export const PHASE16_KERNEL_LAYOUT = PHASE15_KERNEL_LAYOUT;

export const PHASE16_MOTD = 'welcome to jscpu-os phase 16\n';

// Build a bootable Phase 16 disk image: the Phase 15 compiled userland plus
// /bin/date and /bin/shutdown, a seed /etc/motd, and a boot manifest naming
// /bin/init. buildUserExecutable reuses the Phase 15 loader layout/libc.
export function buildPhase16DiskImage(): Uint8Array {
  const disk = BlockDisk.blank(1024); // 1024 * 512 = 512 KiB
  const ports = new PortBus();
  ports.register(PORT.DISK_DATA, 1, disk);
  ports.register(PORT.DISK_POS, 1, disk);
  ports.register(PORT.DISK_SECTORS, 1, disk);

  const driver = new BlockDriver(ports);
  const fs = new Fs(driver);
  fs.mkfs();
  fs.writeFile('/bin/init', buildUserExecutable('init', sourceFile('userland/init.c')));
  fs.writeFile('/bin/sh', buildUserExecutable('sh', sourceFile('userland/sh.c')));
  fs.writeFile('/bin/echo', buildUserExecutable('echo', sourceFile('userland/echo.c')));
  fs.writeFile('/bin/cat', buildUserExecutable('cat', sourceFile('userland/cat.c')));
  fs.writeFile('/bin/ls', buildUserExecutable('ls', sourceFile('userland/ls.c')));
  fs.writeFile('/bin/date', buildUserExecutable('date', sourceFile('userland/date.c')));
  fs.writeFile('/bin/shutdown', buildUserExecutable('shutdown', sourceFile('userland/shutdown.c')));
  fs.writeFile('/etc/motd', new TextEncoder().encode(PHASE16_MOTD));

  driver.write(0, encodeBootBlock(makeBootBlock('/bin/init')));
  return disk.data;
}

function phase16Defines(): Defines {
  return {
    ...phase15Defines(),
    CFG_RTC_DATA: PORT.RTC_DATA,
    CFG_POWER: PORT.POWER,
    CFG_POWER_OFF: POWER_OFF,
  };
}

export const PHASE16_GUEST_KERNEL_SOURCE = loadKernelSource('phase16.c', phase16Defines());

export function buildPhase16KernelImage(): KernelImage {
  const image = linkKernelImage([
    compileC(PHASE16_GUEST_KERNEL_SOURCE, {
      start: 'kernel',
      cStackSize: 8192,
      moduleId: 'phase16',
    }),
  ]);
  if (image.flat.length > PHASE16_KERNEL_LAYOUT.idt) {
    throw new Error(
      `Phase 16 kernel image overlaps reserved IDT/page-table region: image end 0x${image.flat.length.toString(16)}, IDT 0x${PHASE16_KERNEL_LAYOUT.idt.toString(16)}`,
    );
  }
  return image;
}
