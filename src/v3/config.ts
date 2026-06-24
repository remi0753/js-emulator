import { SYS } from '../abi.ts';
import { BOOT_MAGIC } from '../formats/bootblock.ts';
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
const PIPESZ = 512;
const MAXARG = 16;
const MAX_VMAS = 16;
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
  CFG_NFD: NFD,
  CFG_NFILE: NFILE,
  CFG_NPIPE: NPIPE,
  CFG_PIPESZ: PIPESZ,
  CFG_MAXARG: MAXARG,
  CFG_MAX_VMAS: MAX_VMAS,
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
  CFG_ST_STOPPED: PROCESS_STATE.stopped,
  CFG_FT_NONE: FILE_TYPE.none,
  CFG_FT_CONS: FILE_TYPE.console,
  CFG_FT_KBD: FILE_TYPE.keyboard,
  CFG_FT_FILE: FILE_TYPE.file,
  CFG_FT_PIPE: FILE_TYPE.pipe,
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
  CFG_CLOCK_REALTIME: 0,
  CFG_CLOCK_MONOTONIC: 1,
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
int waitpid(int pid, int *status, int options);
int exec(char *path, char **argv);
int getpid(void);
int getppid(void);
int kill(int pid, int signal);
typedef void (*sighandler_t)(int signal);
struct sigaction {
  sighandler_t handler;
  int mask;
  int flags;
  int restorer;
};
int signal(int signal, sighandler_t handler);
int sigaction(int signal, struct sigaction *action, struct sigaction *old_action);
int sigprocmask(int how, int mask, int *old_mask);
int setpgid(int pid, int pgid);
int setsid(void);
int tcsetpgrp(int pgid);
int tcgetpgrp(void);
int pipe(int *fds);
int dup(int fd);
int fcntl(int fd, int command, int argument);
int ioctl(int fd, int request, int argument);
struct timespec {
  int tv_sec;
  int tv_nsec;
};
struct timeval {
  int tv_sec;
  int tv_usec;
};
struct mmap_args {
  int address;
  int length;
  int protection;
  int flags;
  int fd;
  int offset;
};
struct utsname {
  char sysname[32];
  char nodename[32];
  char release[32];
  char version[32];
  char machine[32];
  char domainname[32];
};
struct dirent {
  int ino;
  int offset;
  int reclen;
  int type;
  char name[16];
};
struct stat {
  int dev;
  int ino;
  int mode;
  int nlink;
  int uid;
  int gid;
  int rdev;
  int size;
  int blksize;
  int blocks;
  int atime;
  int mtime;
  int ctime;
};
int nanosleep(struct timespec *request, struct timespec *remaining);
int brk(void *address);
void *sbrk(int increment);
void *mmap(void *address, int length, int protection, int flags, int fd, int offset);
int munmap(void *address, int length);
int mprotect(void *address, int length, int protection);
int gettimeofday(struct timeval *value, void *timezone);
int clock_gettime(int clock_id, struct timespec *value);
int uname(struct utsname *name);
int getdents(int fd, struct dirent *entries, int count);
int stat(char *path, struct stat *value);
int fstat(int fd, struct stat *value);
int lstat(char *path, struct stat *value);
int chmod(char *path, int mode);
int chown(char *path, int uid, int gid);
int mkdir(char *path, int mode);
int rmdir(char *path);
int unlink(char *path);
int link(char *oldpath, char *newpath);
int rename(char *oldpath, char *newpath);
int symlink(char *target, char *linkpath);
int readlink(char *path, char *buffer, int size);
int lseek(int fd, int offset, int whence);
int getuid(void);
int getgid(void);
void exit(int code);
int time(void);
void shutdown(void);

#endif
`;
}
