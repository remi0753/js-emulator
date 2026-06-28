import { SYS } from '../abi.ts';
import { BOOT_MAGIC } from '../formats/bootblock.ts';
import {
  ARG_SIZE,
  FLAG,
  IDT_ENTRY_SIZE,
  IDT_PRESENT,
  IDT_USER,
  KEYBOARD_IRQ,
  NETWORK_IRQ,
  SYSCALL_INT,
  TIMER_IRQ,
  TRAP,
} from '../isa.ts';
import {
  DINODE_SIZE,
  DIRSIZ,
  FS_VERSION,
  FSMAGIC,
  NDIRECT,
  ROOTINO,
  S_IFDIR,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  T_DIR,
  T_FILE,
  T_SYMLINK,
} from '../storage/fs.ts';
import { MODE } from '../vm/custom32/cpu.ts';
import { SECTOR_SIZE } from '../vm/custom32/devices/disk.ts';
import { POWER_OFF } from '../vm/custom32/devices/power.ts';
import { PORT } from '../vm/custom32/platform.ts';

export type Defines = Readonly<Record<string, number>>;

const MAX_PROC = 8;
const NBUF = 16;
const NFD = 16;
const NFILE = MAX_PROC * NFD;
const NPIPE = 8;
const NSOCKET = 8;
const NMOUNT = 5;
const NTMPNODE = 16;
const NCHARDEV = 10; // registered char-device drivers (device.c)
const NIRQ = 8; // device IRQ lines routed through request_irq/irq_dispatch
const KLOG_SIZE = 4096; // kernel log ring buffer (klog.c), exposed via /dev/kmsg
const TMP_FILE_SIZE = 512;
const PIPESZ = 512;
const MAXARG = 16;
const MAX_VMAS = 16;
const PAGE_CACHE_SIZE = 128;
const ARGBUF_LEN = 512;
const IPB = Math.floor(SECTOR_SIZE / DINODE_SIZE);
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
  stopped: 4,
} as const;

const FILE_TYPE = {
  none: 0,
  console: 1,
  keyboard: 2,
  file: 3,
  pipe: 4,
  socket: 5,
} as const;

const FS_TYPE = {
  disk: 1,
  dev: 2,
  proc: 3,
  tmp: 4,
  sys: 5,
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
  EAGAIN: 11,
  EEXIST: 17,
  EFAULT: 14,
  EACCES: 13,
  ENODEV: 19,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  EPIPE: 32,
  EINTR: 4,
  ENOTTY: 25,
  EFBIG: 27,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EMLINK: 31,
  ENAMETOOLONG: 36,
  ENOTEMPTY: 39,
  ELOOP: 40,
  ENOSYS: 38,
  EMSGSIZE: 90,
  EPROTONOSUPPORT: 93,
  EOPNOTSUPP: 95,
  EAFNOSUPPORT: 97,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  EDESTADDRREQ: 89,
  ENOTSOCK: 88,
} as const;

const SIGNAL = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
} as const;

export const GUEST_EXECUTABLE_MAGIC = 0x35315850;

export const GUEST_KERNEL_LAYOUT = {
  idt: 0xd0000,
  kernelPageTable: 0xd1000,
  kstackTop: 0x100000,
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
  CFG_SYS_UPTIME: SYS.UPTIME,
  CFG_SYS_TIME: SYS.TIME,
  CFG_SYS_SHUTDOWN: SYS.SHUTDOWN,
  CFG_SYS_KILL: SYS.KILL,
  CFG_SYS_SIGACTION: SYS.SIGACTION,
  CFG_SYS_SIGPROCMASK: SYS.SIGPROCMASK,
  CFG_SYS_SIGRETURN: SYS.SIGRETURN,
  CFG_SYS_WAITPID: SYS.WAITPID,
  CFG_SYS_SETPGID: SYS.SETPGID,
  CFG_SYS_SETSID: SYS.SETSID,
  CFG_SYS_TCSETPGRP: SYS.TCSETPGRP,
  CFG_SYS_TCGETPGRP: SYS.TCGETPGRP,
  CFG_SYS_GETPPID: SYS.GETPPID,
  CFG_SYS_NANOSLEEP: SYS.NANOSLEEP,
  CFG_SYS_BRK: SYS.BRK,
  CFG_SYS_MMAP: SYS.MMAP,
  CFG_SYS_MUNMAP: SYS.MUNMAP,
  CFG_SYS_MPROTECT: SYS.MPROTECT,
  CFG_SYS_FCNTL: SYS.FCNTL,
  CFG_SYS_IOCTL: SYS.IOCTL,
  CFG_SYS_GETTIMEOFDAY: SYS.GETTIMEOFDAY,
  CFG_SYS_CLOCK_GETTIME: SYS.CLOCK_GETTIME,
  CFG_SYS_UNAME: SYS.UNAME,
  CFG_SYS_GETDENTS: SYS.GETDENTS,
  CFG_SYS_STAT: SYS.STAT,
  CFG_SYS_FSTAT: SYS.FSTAT,
  CFG_SYS_LSTAT: SYS.LSTAT,
  CFG_SYS_CHMOD: SYS.CHMOD,
  CFG_SYS_CHOWN: SYS.CHOWN,
  CFG_SYS_MKDIR: SYS.MKDIR,
  CFG_SYS_RMDIR: SYS.RMDIR,
  CFG_SYS_UNLINK: SYS.UNLINK,
  CFG_SYS_LINK: SYS.LINK,
  CFG_SYS_RENAME: SYS.RENAME,
  CFG_SYS_SYMLINK: SYS.SYMLINK,
  CFG_SYS_READLINK: SYS.READLINK,
  CFG_SYS_LSEEK: SYS.LSEEK,
  CFG_SYS_GETUID: SYS.GETUID,
  CFG_SYS_GETGID: SYS.GETGID,
  CFG_SYS_POLL: SYS.POLL,
  CFG_SYS_SOCKET: SYS.SOCKET,
  CFG_SYS_BIND: SYS.BIND,
  CFG_SYS_LISTEN: SYS.LISTEN,
  CFG_SYS_ACCEPT: SYS.ACCEPT,
  CFG_SYS_CONNECT: SYS.CONNECT,
  CFG_SYS_SEND: SYS.SEND,
  CFG_SYS_RECV: SYS.RECV,
  CFG_SYS_SETSOCKOPT: SYS.SETSOCKOPT,
  CFG_SYS_SENDTO: SYS.SENDTO,
  CFG_SYS_RECVFROM: SYS.RECVFROM,
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
  CFG_TIMER_IRQ: TIMER_IRQ,
  CFG_KBD_IRQ: KEYBOARD_IRQ,
  CFG_NET_IRQ: NETWORK_IRQ,
  CFG_NET_STATUS: PORT.NET_STATUS,
  CFG_NET_RX_LEN: PORT.NET_RX_LEN,
  CFG_NET_RX_DATA: PORT.NET_RX_DATA,
  CFG_NET_TX_LEN: PORT.NET_TX_LEN,
  CFG_NET_TX_DATA: PORT.NET_TX_DATA,
  CFG_NET_VECTOR: TRAP.IRQ_BASE + NETWORK_IRQ,
  CFG_DISK_POS: PORT.DISK_POS,
  CFG_DISK_DATA: PORT.DISK_DATA,
  CFG_RTC_DATA: PORT.RTC_DATA,
  CFG_ENTROPY: PORT.ENTROPY,
  CFG_POWER: PORT.POWER,
  CFG_POWER_OFF: POWER_OFF,
  CFG_PTE_KERNEL: PTE_KERNEL,
  CFG_PTE_USER: PTE_USER,
  CFG_PTE_COW: 1 << 9,
  CFG_PTE_SHARED: 1 << 10,
  CFG_MAX_PROC: MAX_PROC,
  CFG_NFD: NFD,
  CFG_NFILE: NFILE,
  CFG_NPIPE: NPIPE,
  CFG_NSOCKET: NSOCKET,
  CFG_NMOUNT: NMOUNT,
  CFG_NCHARDEV: NCHARDEV,
  CFG_NIRQ: NIRQ,
  CFG_KLOG_SIZE: KLOG_SIZE,
  // Runtime trace bitmask (klog.c), set through /sys/trace. Each bit makes a
  // subsystem emit structured trace lines into the kernel log.
  CFG_TRACE_SYSCALL: 1 << 0,
  CFG_TRACE_DISK: 1 << 1,
  CFG_TRACE_FAULT: 1 << 2,
  CFG_NTMPNODE: NTMPNODE,
  CFG_TMP_FILE_SIZE: TMP_FILE_SIZE,
  CFG_PIPESZ: PIPESZ,
  CFG_MAXARG: MAXARG,
  CFG_MAX_VMAS: MAX_VMAS,
  CFG_PAGE_CACHE_SIZE: PAGE_CACHE_SIZE,
  CFG_ARGBUF_LEN: ARGBUF_LEN,
  CFG_FRAME_POOL_BASE: GUEST_KERNEL_LAYOUT.framePoolBase,
  CFG_FRAME_POOL_END: GUEST_KERNEL_LAYOUT.framePoolEnd,
  CFG_PHYS_FRAMES: GUEST_KERNEL_LAYOUT.physSize / 4096,
  CFG_KERNEL_PT: GUEST_KERNEL_LAYOUT.kernelPageTable,
  CFG_USER_LOAD_BASE: GUEST_KERNEL_LAYOUT.userLoadBase,
  CFG_USER_STACK_PAGE: GUEST_KERNEL_LAYOUT.userStackPage,
  CFG_USER_GUARD_PAGE: GUEST_KERNEL_LAYOUT.userStackPage - 4096,
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
  CFG_ST_STOPPED: PROCESS_STATE.stopped,
  CFG_FT_NONE: FILE_TYPE.none,
  CFG_FT_CONS: FILE_TYPE.console,
  CFG_FT_KBD: FILE_TYPE.keyboard,
  CFG_FT_FILE: FILE_TYPE.file,
  CFG_FT_PIPE: FILE_TYPE.pipe,
  CFG_FT_SOCKET: FILE_TYPE.socket,
  CFG_FS_DISK: FS_TYPE.disk,
  CFG_FS_DEV: FS_TYPE.dev,
  CFG_FS_PROC: FS_TYPE.proc,
  CFG_FS_TMP: FS_TYPE.tmp,
  CFG_FS_SYS: FS_TYPE.sys,
  CFG_NBUF: NBUF,
  CFG_BUF_DATA_LEN: NBUF * SECTOR_SIZE,
  CFG_INITPATH_LEN: 64,
  CFG_FS_MAGIC: FSMAGIC,
  CFG_FS_VERSION: FS_VERSION,
  CFG_BOOT_MAGIC: BOOT_MAGIC,
  CFG_EXEC_MAGIC: GUEST_EXECUTABLE_MAGIC,
  CFG_IPB: IPB,
  CFG_DINODE_SIZE: DINODE_SIZE,
  CFG_NDIRECT: NDIRECT,
  CFG_NINDIRECT: SECTOR_SIZE / 4,
  CFG_MAXFILE: NDIRECT + SECTOR_SIZE / 4,
  CFG_DIRSIZ: DIRSIZ,
  CFG_ROOTINO: ROOTINO,
  CFG_T_FILE: T_FILE,
  CFG_T_DIR: T_DIR,
  CFG_T_SYMLINK: T_SYMLINK,
  CFG_S_IFMT: S_IFMT,
  CFG_S_IFDIR: S_IFDIR,
  CFG_S_IFREG: S_IFREG,
  CFG_S_IFLNK: S_IFLNK,
  CFG_S_IFCHR: 0x2000,
  CFG_SEEK_SET: 0,
  CFG_SEEK_CUR: 1,
  CFG_SEEK_END: 2,
  CFG_NSIG: 32,
  CFG_SIG_DFL: 0,
  CFG_SIG_IGN: 1,
  CFG_SIGHUP: SIGNAL.SIGHUP,
  CFG_SIGINT: SIGNAL.SIGINT,
  CFG_SIGKILL: SIGNAL.SIGKILL,
  CFG_SIGUSR1: SIGNAL.SIGUSR1,
  CFG_SIGSEGV: SIGNAL.SIGSEGV,
  CFG_SIGTERM: SIGNAL.SIGTERM,
  CFG_SIGCHLD: SIGNAL.SIGCHLD,
  CFG_SIGCONT: SIGNAL.SIGCONT,
  CFG_SIGSTOP: SIGNAL.SIGSTOP,
  CFG_SIGTSTP: SIGNAL.SIGTSTP,
  CFG_SIGTTIN: SIGNAL.SIGTTIN,
  CFG_SIGTTOU: SIGNAL.SIGTTOU,
  CFG_SIG_BLOCK: 0,
  CFG_SIG_UNBLOCK: 1,
  CFG_SIG_SETMASK: 2,
  CFG_WNOHANG: 1,
  CFG_WUNTRACED: 2,
  CFG_WCONTINUED: 4,
  CFG_TICKS_PER_SEC: 100,
  CFG_PROT_NONE: 0,
  CFG_PROT_READ: 1,
  CFG_PROT_WRITE: 2,
  CFG_PROT_EXEC: 4,
  CFG_MAP_SHARED: 1,
  CFG_MAP_PRIVATE: 2,
  CFG_MAP_FIXED: 16,
  CFG_MAP_ANONYMOUS: 32,
  CFG_F_DUPFD: 0,
  CFG_F_GETFD: 1,
  CFG_F_SETFD: 2,
  CFG_F_GETFL: 3,
  CFG_F_SETFL: 4,
  CFG_FD_CLOEXEC: 1,
  CFG_O_NONBLOCK: 0x800,
  CFG_O_ACCMODE: 3,
  CFG_O_WRONLY: 1,
  CFG_O_RDWR: 2,
  CFG_O_CREATE: 0x200,
  CFG_O_TRUNC: 0x400,
  CFG_TIOCGPGRP: 0x540f,
  CFG_TIOCSPGRP: 0x5410,
  CFG_TCGETS: 0x5401,
  CFG_TCSETS: 0x5402,
  CFG_TCSETSW: 0x5403,
  CFG_TCSETSF: 0x5404,
  CFG_TIOCGWINSZ: 0x5413,
  CFG_TIOCSWINSZ: 0x5414,
  CFG_TTY_ISIG: 1,
  CFG_TTY_ICANON: 2,
  CFG_TTY_ECHO: 8,
  CFG_TTY_ECHOE: 16,
  CFG_TTY_VINTR: 0,
  CFG_TTY_VERASE: 2,
  CFG_TTY_VKILL: 3,
  CFG_TTY_VEOF: 4,
  CFG_TTY_VTIME: 5,
  CFG_TTY_VMIN: 6,
  CFG_TTY_VSUSP: 10,
  CFG_CLOCK_REALTIME: 0,
  CFG_CLOCK_MONOTONIC: 1,
  CFG_POLLIN: 0x001,
  CFG_POLLOUT: 0x004,
  CFG_POLLERR: 0x008,
  CFG_POLLHUP: 0x010,
  CFG_POLLNVAL: 0x020,
  CFG_AF_INET: 2,
  CFG_SOCK_STREAM: 1,
  CFG_SOCK_DGRAM: 2,
  CFG_IPPROTO_TCP: 6,
  CFG_IPPROTO_UDP: 17,
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

// Intrinsics recognized by src/toolchain/chibicc.
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

// Public userland ABI. Keeping it in one real header makes the editor and the
// guest compiler consume the same declarations.
#include "userland/libc.h"

#endif
`;
}
