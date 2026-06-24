// Minimal libc for the Phase 15 guest userland: thin wrappers over the guest
// kernel's INT 0x80 syscall ABI. Compiled as a freestanding object (start:
// 'none') and linked into every program; crt0 and the string/memory runtime
// helpers (memcpy/memset/strlen/strcmp) come from the toolchain runtime.
//
// The syscall-number tokens are substituted by ../guest-kernel.ts so the numbers
// stay a single source of truth shared with the kernel.

// Last error number, set whenever a syscall wrapper fails. Programs that want
// the specific cause declare `extern int errno;` and read it after a -1 return.
int errno;

typedef void (*sighandler_t)(int signal);

struct sigaction {
  sighandler_t handler;
  int mask;
  int flags;
  int restorer;
};

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

struct termios {
  int iflag;
  int oflag;
  int cflag;
  int lflag;
  int line;
  int cc[12];
};

struct winsize {
  int rows;
  int cols;
  int xpixel;
  int ypixel;
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

sighandler_t signal_handlers[32];
int signal_current;

// The kernel enters caught handlers with the signal number in R0. This common
// dispatcher moves it into normal C calling-convention storage, invokes the
// application handler, then RETs to signal_restorer on the user hardware stack.
void signal_dispatch() {
  asm("STORE R0, signal_current\n");
  signal_handlers[signal_current](signal_current);
}

void signal_restorer() {
  __syscall(CFG_SYS_SIGRETURN, 0, 0, 0);
}

// Translate a raw syscall result into the classic libc convention: a negative
// kernel return is an errno, reported as errno + a -1 return; a non-negative
// result passes through unchanged.
int ret_errno(int r) {
  if (r < 0) {
    errno = 0 - r;
    return -1;
  }
  return r;
}

int write(int fd, char *buf, int n) {
  return ret_errno(__syscall(CFG_SYS_WRITE, fd, buf, n));
}

int read(int fd, char *buf, int n) {
  return ret_errno(__syscall(CFG_SYS_READ, fd, buf, n));
}

int open(char *path, int flags) {
  return ret_errno(__syscall(CFG_SYS_OPEN, path, flags, 0));
}

int close(int fd) {
  return ret_errno(__syscall(CFG_SYS_CLOSE, fd, 0, 0));
}

int fork() {
  return ret_errno(__syscall(CFG_SYS_FORK, 0, 0, 0));
}

int wait() {
  return ret_errno(__syscall(CFG_SYS_WAIT, 0, 0, 0));
}

int waitpid(int pid, int *status, int options) {
  return ret_errno(__syscall(CFG_SYS_WAITPID, pid, status, options));
}

int exec(char *path, char **argv) {
  return ret_errno(__syscall(CFG_SYS_EXEC, path, argv, 0));
}

int getpid() {
  return ret_errno(__syscall(CFG_SYS_GETPID, 0, 0, 0));
}

int getppid() {
  return ret_errno(__syscall(CFG_SYS_GETPPID, 0, 0, 0));
}

int kill(int pid, int sig) {
  return ret_errno(__syscall(CFG_SYS_KILL, pid, sig, 0));
}

int sigaction(int sig, struct sigaction *action, struct sigaction *old_action) {
  struct sigaction kernel_action;
  struct sigaction kernel_old;
  struct sigaction *kernel_action_ptr;
  struct sigaction *kernel_old_ptr;
  sighandler_t previous_handler;
  sighandler_t next_handler;
  int result;
  previous_handler = 0;
  if (sig >= 0 && sig < 32) {
    previous_handler = signal_handlers[sig];
  }
  next_handler = previous_handler;
  kernel_action_ptr = 0;
  kernel_old_ptr = 0;
  if (action != 0) {
    kernel_action.mask = action->mask;
    kernel_action.flags = action->flags;
    kernel_action.restorer = signal_restorer;
    if (action->handler == 0 || action->handler == 1) {
      kernel_action.handler = action->handler;
      next_handler = action->handler;
    } else {
      next_handler = action->handler;
      kernel_action.handler = signal_dispatch;
    }
    kernel_action_ptr = &kernel_action;
  }
  if (old_action != 0) {
    kernel_old_ptr = &kernel_old;
  }
  result = ret_errno(
    __syscall(CFG_SYS_SIGACTION, sig, kernel_action_ptr, kernel_old_ptr));
  if (result == 0 && old_action != 0) {
    old_action->mask = kernel_old.mask;
    old_action->flags = kernel_old.flags;
    old_action->restorer = 0;
    if (kernel_old.handler == signal_dispatch) {
      old_action->handler = previous_handler;
    } else {
      old_action->handler = kernel_old.handler;
    }
  }
  if (result == 0 && action != 0) {
    signal_handlers[sig] = next_handler;
  }
  return result;
}

int signal(int sig, sighandler_t handler) {
  struct sigaction action;
  struct sigaction old_action;
  action.handler = handler;
  action.mask = 0;
  action.flags = 0;
  action.restorer = 0;
  if (sigaction(sig, &action, &old_action) < 0) {
    return -1;
  }
  return old_action.handler;
}

int sigprocmask(int how, int mask, int *old_mask) {
  return ret_errno(__syscall(CFG_SYS_SIGPROCMASK, how, mask, old_mask));
}

int setpgid(int pid, int pgid) {
  return ret_errno(__syscall(CFG_SYS_SETPGID, pid, pgid, 0));
}

int setsid() {
  return ret_errno(__syscall(CFG_SYS_SETSID, 0, 0, 0));
}

int tcsetpgrp(int pgid) {
  return ret_errno(__syscall(CFG_SYS_TCSETPGRP, pgid, 0, 0));
}

int tcgetpgrp() {
  return ret_errno(__syscall(CFG_SYS_TCGETPGRP, 0, 0, 0));
}

int pipe(int *fds) {
  return ret_errno(__syscall(CFG_SYS_PIPE, fds, 0, 0));
}

int dup(int fd) {
  return ret_errno(__syscall(CFG_SYS_DUP, fd, 0, 0));
}

int fcntl(int fd, int command, int argument) {
  return ret_errno(__syscall(CFG_SYS_FCNTL, fd, command, argument));
}

int ioctl(int fd, int request, int argument) {
  return ret_errno(__syscall(CFG_SYS_IOCTL, fd, request, argument));
}

int tcgetattr(int fd, struct termios *attributes) {
  return ioctl(fd, CFG_TCGETS, attributes);
}

int tcsetattr(int fd, int actions, struct termios *attributes) {
  int request;
  request = CFG_TCSETS;
  if (actions == 1) request = CFG_TCSETSW;
  else if (actions == 2) request = CFG_TCSETSF;
  return ioctl(fd, request, attributes);
}

int tcgetwinsize(int fd, struct winsize *size) {
  return ioctl(fd, CFG_TIOCGWINSZ, size);
}

int tcsetwinsize(int fd, struct winsize *size) {
  return ioctl(fd, CFG_TIOCSWINSZ, size);
}

int isatty(int fd) {
  struct termios attributes;
  return tcgetattr(fd, &attributes) == 0;
}

int nanosleep(struct timespec *request, struct timespec *remaining) {
  return ret_errno(__syscall(CFG_SYS_NANOSLEEP, request, remaining, 0));
}

int brk(void *address) {
  int result;
  result = ret_errno(__syscall(CFG_SYS_BRK, address, 0, 0));
  if (result < 0) {
    return -1;
  }
  return 0;
}

void *sbrk(int increment) {
  int old_break;
  int new_break;
  old_break = ret_errno(__syscall(CFG_SYS_BRK, 0, 0, 0));
  if (old_break < 0) {
    return -1;
  }
  new_break = ret_errno(
    __syscall(CFG_SYS_BRK, old_break + increment, 0, 0));
  if (new_break < 0) {
    return -1;
  }
  return old_break;
}

void *mmap(void *address, int length, int protection, int flags, int fd, int offset) {
  struct mmap_args arguments;
  int result;
  arguments.address = address;
  arguments.length = length;
  arguments.protection = protection;
  arguments.flags = flags;
  arguments.fd = fd;
  arguments.offset = offset;
  result = ret_errno(__syscall(CFG_SYS_MMAP, &arguments, 0, 0));
  if (result < 0) {
    return -1;
  }
  return result;
}

int munmap(void *address, int length) {
  return ret_errno(__syscall(CFG_SYS_MUNMAP, address, length, 0));
}

int mprotect(void *address, int length, int protection) {
  return ret_errno(__syscall(CFG_SYS_MPROTECT, address, length, protection));
}

int gettimeofday(struct timeval *value, void *timezone) {
  return ret_errno(__syscall(CFG_SYS_GETTIMEOFDAY, value, timezone, 0));
}

int clock_gettime(int clock_id, struct timespec *value) {
  return ret_errno(__syscall(CFG_SYS_CLOCK_GETTIME, clock_id, value, 0));
}

int uname(struct utsname *name) {
  return ret_errno(__syscall(CFG_SYS_UNAME, name, 0, 0));
}

int getdents(int fd, struct dirent *entries, int count) {
  return ret_errno(__syscall(CFG_SYS_GETDENTS, fd, entries, count));
}

int stat(char *path, struct stat *value) {
  return ret_errno(__syscall(CFG_SYS_STAT, path, value, 0));
}

int fstat(int fd, struct stat *value) {
  return ret_errno(__syscall(CFG_SYS_FSTAT, fd, value, 0));
}

int lstat(char *path, struct stat *value) {
  return ret_errno(__syscall(CFG_SYS_LSTAT, path, value, 0));
}

int chmod(char *path, int mode) {
  return ret_errno(__syscall(CFG_SYS_CHMOD, path, mode, 0));
}

int chown(char *path, int uid, int gid) {
  return ret_errno(__syscall(CFG_SYS_CHOWN, path, uid, gid));
}

int mkdir(char *path, int mode) {
  return ret_errno(__syscall(CFG_SYS_MKDIR, path, mode, 0));
}

int rmdir(char *path) {
  return ret_errno(__syscall(CFG_SYS_RMDIR, path, 0, 0));
}

int unlink(char *path) {
  return ret_errno(__syscall(CFG_SYS_UNLINK, path, 0, 0));
}

int link(char *oldpath, char *newpath) {
  return ret_errno(__syscall(CFG_SYS_LINK, oldpath, newpath, 0));
}

int rename(char *oldpath, char *newpath) {
  return ret_errno(__syscall(CFG_SYS_RENAME, oldpath, newpath, 0));
}

int symlink(char *target, char *linkpath) {
  return ret_errno(__syscall(CFG_SYS_SYMLINK, target, linkpath, 0));
}

int readlink(char *path, char *buffer, int size) {
  return ret_errno(__syscall(CFG_SYS_READLINK, path, buffer, size));
}

int lseek(int fd, int offset, int whence) {
  return ret_errno(__syscall(CFG_SYS_LSEEK, fd, offset, whence));
}

int getuid() {
  return ret_errno(__syscall(CFG_SYS_GETUID, 0, 0, 0));
}

int getgid() {
  return ret_errno(__syscall(CFG_SYS_GETGID, 0, 0, 0));
}

void exit(int code) {
  __syscall(CFG_SYS_EXIT, code, 0, 0);
}

// Current wall-clock time in whole seconds (Unix epoch), from the RTC device.
int time() {
  return ret_errno(__syscall(CFG_SYS_TIME, 0, 0, 0));
}

// Power the machine off cleanly. Does not return.
void shutdown() {
  __syscall(CFG_SYS_SHUTDOWN, 0, 0, 0);
}
