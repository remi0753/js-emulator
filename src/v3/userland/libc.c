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

int exec(char *path, char **argv) {
  return ret_errno(__syscall(CFG_SYS_EXEC, path, argv, 0));
}

int getpid() {
  return ret_errno(__syscall(CFG_SYS_GETPID, 0, 0, 0));
}

int pipe(int *fds) {
  return ret_errno(__syscall(CFG_SYS_PIPE, fds, 0, 0));
}

int dup(int fd) {
  return ret_errno(__syscall(CFG_SYS_DUP, fd, 0, 0));
}

void exit(int code) {
  __syscall(CFG_SYS_EXIT, code, 0, 0);
}

// Current wall-clock time in whole seconds (Unix epoch), from the RTC device.
int time() {
  return __syscall(CFG_SYS_TIME, 0, 0, 0);
}

// Power the machine off cleanly. Does not return.
void shutdown() {
  __syscall(CFG_SYS_SHUTDOWN, 0, 0, 0);
}
