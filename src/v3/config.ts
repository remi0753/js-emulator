import {
  ARG_SIZE,
  FLAG,
  IDT_ENTRY_SIZE,
  IDT_PRESENT,
  IDT_USER,
  KEYBOARD_IRQ,
  SYSCALL_INT,
  TIMER_IRQ,
  TRAP,
} from '../isa.ts';
import { SYS } from '../v2/kernel/abi.ts';
import { BOOT_MAGIC } from '../v2/kernel/bootblock.ts';
import { DIRSIZ, FSMAGIC, NDIRECT, ROOTINO, T_DIR, T_FILE } from '../v2/kernel/fs.ts';
import { MODE } from '../vm/custom32/cpu.ts';
import { SECTOR_SIZE } from '../vm/custom32/devices/disk.ts';
import { POWER_OFF } from '../vm/custom32/devices/power.ts';
import { PORT } from '../vm/custom32/platform.ts';

export type Defines = Readonly<Record<string, number>>;

const MAX_PROC = 8;
const NBUF = 16;
const NFD = 16;
const NPIPE = 8;
const PIPESZ = 512;
const MAXARG = 16;
const ARGBUF_LEN = 512;
const DINODE_SIZE = 64;
const IPB = SECTOR_SIZE / DINODE_SIZE;
const PTE_KERNEL = 3;
const PTE_USER = 7;

const PROCESS_STATE = {
  unused: 0,
  runnable: 1,
  zombie: 2,
  // Blocked on a wait channel; woken by wakeup(chan). One state backs every
  // kind of blocking (wait/pipe/keyboard) -- the sleeper re-checks its
  // condition after waking.
  sleeping: 3,
} as const;

const FILE_TYPE = {
  none: 0,
  console: 1,
  keyboard: 2,
  file: 3,
  pipe: 4,
} as const;

// Stable negative errno values (Linux numbers). Syscalls return -ERRNO on
// failure; libc translates that into the classic -1 return plus a `errno`
// global. Kept here as the single source of truth, shared with the editor
// header via gen:c-headers.
const ERRNO = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  E2BIG: 7,
  ENOEXEC: 8,
  EBADF: 9,
  ECHILD: 10,
  ENOMEM: 12,
  EFAULT: 14,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  EPIPE: 32,
  ENOSYS: 38,
} as const;

export const GUEST_EXECUTABLE_MAGIC = 0x35315850;

export const GUEST_KERNEL_LAYOUT = {
  idt: 0x40000,
  kernelPageTable: 0x41000,
  kstackTop: 0x50000,
  framePoolBase: 0x100000,
  framePoolEnd: 0x380000,
  timerPeriod: 8000,
  physSize: 0x400000,
  userLoadBase: 0x400000,
  userStackPage: 0x7ff000,
  userStackTop: 0x800000,
  userBase: 0x400000,
  userEnd: 0x800000,
} as const;

// Size of the syscall dispatch table: one slot per number, 0 to the max.
const NSYS = Math.max(...Object.values(SYS)) + 1;

export const GUEST_SYSCALL_DEFINES: Defines = {
  CFG_NSYS: NSYS,
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
  CFG_SYS_TIME: SYS.TIME,
  CFG_SYS_SHUTDOWN: SYS.SHUTDOWN,
};

const ERRNO_DEFINES: Defines = Object.fromEntries(
  Object.entries(ERRNO).map(([name, value]) => [`CFG_${name}`, value]),
);

export const GUEST_KERNEL_DEFINES: Defines = {
  ...GUEST_SYSCALL_DEFINES,
  ...ERRNO_DEFINES,
  CFG_CONSOLE_DATA: PORT.CONSOLE_DATA,
  CFG_KBD_DATA: PORT.KBD_DATA,
  CFG_KBD_STATUS: PORT.KBD_STATUS,
  CFG_KBD_VECTOR: TRAP.IRQ_BASE + KEYBOARD_IRQ,
  CFG_DISK_POS: PORT.DISK_POS,
  CFG_DISK_DATA: PORT.DISK_DATA,
  CFG_RTC_DATA: PORT.RTC_DATA,
  CFG_POWER: PORT.POWER,
  CFG_POWER_OFF: POWER_OFF,
  CFG_PTE_KERNEL: PTE_KERNEL,
  CFG_PTE_USER: PTE_USER,
  CFG_MAX_PROC: MAX_PROC,
  CFG_PROC_REG_COUNT: MAX_PROC * 8,
  CFG_NFD: NFD,
  CFG_FD_TABLE_LEN: MAX_PROC * NFD,
  CFG_NPIPE: NPIPE,
  CFG_PIPESZ: PIPESZ,
  CFG_PIPE_BUF_LEN: NPIPE * PIPESZ,
  CFG_MAXARG: MAXARG,
  CFG_ARGBUF_LEN: ARGBUF_LEN,
  CFG_FRAME_POOL_BASE: GUEST_KERNEL_LAYOUT.framePoolBase,
  CFG_FRAME_POOL_END: GUEST_KERNEL_LAYOUT.framePoolEnd,
  CFG_KERNEL_PT: GUEST_KERNEL_LAYOUT.kernelPageTable,
  CFG_USER_LOAD_BASE: GUEST_KERNEL_LAYOUT.userLoadBase,
  CFG_USER_STACK_PAGE: GUEST_KERNEL_LAYOUT.userStackPage,
  CFG_USER_STACK_TOP: GUEST_KERNEL_LAYOUT.userStackTop,
  CFG_USER_BASE: GUEST_KERNEL_LAYOUT.userBase,
  CFG_USER_END: GUEST_KERNEL_LAYOUT.userEnd,
  CFG_IDT: GUEST_KERNEL_LAYOUT.idt,
  CFG_IDT_ENTRY_SIZE: IDT_ENTRY_SIZE,
  CFG_IDT_PRESENT: IDT_PRESENT,
  CFG_IDT_USER: IDT_USER,
  CFG_TIMER_VECTOR: TRAP.IRQ_BASE + TIMER_IRQ,
  CFG_PAGEFAULT_VECTOR: TRAP.PAGEFAULT,
  CFG_SYSCALL_VECTOR: SYSCALL_INT,
  CFG_SYSCALL_INSTR_SIZE: 1 + ARG_SIZE.imm,
  CFG_KSTACK_TOP: GUEST_KERNEL_LAYOUT.kstackTop,
  CFG_TIMER_PERIOD: GUEST_KERNEL_LAYOUT.timerPeriod,
  CFG_FLAG_IF: FLAG.IF,
  CFG_MODE_USER: MODE.USER,
  CFG_ST_UNUSED: PROCESS_STATE.unused,
  CFG_ST_RUNNABLE: PROCESS_STATE.runnable,
  CFG_ST_ZOMBIE: PROCESS_STATE.zombie,
  CFG_ST_SLEEPING: PROCESS_STATE.sleeping,
  CFG_FT_NONE: FILE_TYPE.none,
  CFG_FT_CONS: FILE_TYPE.console,
  CFG_FT_KBD: FILE_TYPE.keyboard,
  CFG_FT_FILE: FILE_TYPE.file,
  CFG_FT_PIPE: FILE_TYPE.pipe,
  CFG_NBUF: NBUF,
  CFG_BUF_DATA_LEN: NBUF * SECTOR_SIZE,
  CFG_INITPATH_LEN: 64,
  CFG_FS_MAGIC: FSMAGIC,
  CFG_BOOT_MAGIC: BOOT_MAGIC,
  CFG_EXEC_MAGIC: GUEST_EXECUTABLE_MAGIC,
  CFG_IPB: IPB,
  CFG_DINODE_SIZE: DINODE_SIZE,
  CFG_NDIRECT: NDIRECT,
  CFG_DIRSIZ: DIRSIZ,
  CFG_ROOTINO: ROOTINO,
  CFG_T_FILE: T_FILE,
  CFG_T_DIR: T_DIR,
};

function cInteger(value: number): string {
  return value >= 4096 ? `0x${value.toString(16)}` : String(value);
}

export function renderGuestConfigHeader(): string {
  const definitions = Object.entries(GUEST_KERNEL_DEFINES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `#define ${name} ${cInteger(value)}`)
    .join('\n');

  return `// Generated by npm run gen:c-headers. Do not edit.
#ifndef JSCPU_OS_GUEST_CONFIG_H
#define JSCPU_OS_GUEST_CONFIG_H

${definitions}

// Intrinsics recognized by src/toolchain/c.ts.
int __syscall(int number, int arg1, int arg2, int arg3);
int __out(int port, int value);
int __in(int port);
int __halt(void);
int __iret(void);
int __lidt(int address);
int __lksp(int address);
int __stmr(int period);
int __lptbr(int address);
int __pgon(void);
int __pgoff(void);
int __rdpfla(void);
int __rderr(void);
int __ei(void);
int __di(void);

// Guest libc errno: a negative syscall return becomes errno + a -1 result.
extern int errno;

// Freestanding runtime and guest libc functions.
void *memcpy(void *destination, const void *source, int length);
void *memset(void *destination, int value, int length);
int strlen(const char *text);
int strcmp(const char *left, const char *right);
int write(int fd, char *buffer, int length);
int read(int fd, char *buffer, int length);
int open(char *path, int flags);
int close(int fd);
int fork(void);
int wait(void);
int exec(char *path, char **argv);
int getpid(void);
int pipe(int *fds);
int dup(int fd);
void exit(int code);
int time(void);
void shutdown(void);

#endif
`;
}
