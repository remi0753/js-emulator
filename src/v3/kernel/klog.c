// Kernel log buffer and runtime tracing (Phase 27 observability).
//
// klog() records kernel messages into a ring buffer and mirrors them to
// the serial console, so a failing run can be diagnosed both from host-side
// serial output and from inside the guest by reading /dev/kmsg. Boot, exec,
// shutdown, and panic messages all flow through klog, so they are captured.
//
// A runtime trace bitmask (trace_flags, set by writing /sys/trace) makes the
// syscall dispatcher, the page-fault handler, and the block driver emit
// structured trace lines into the same log. With no tracing enabled klog only
// holds the handful of kernel boot/lifecycle messages, so it never mixes with
// user stdout (which goes straight to the console driver, not through klog).
#include "kernel.h"

char klog_buf[CFG_KLOG_SIZE]; // bounded kernel log; newest bytes are kept
int klog_len;                 // bytes currently held (capped at CFG_KLOG_SIZE)
int klog_total;               // total bytes ever written, including any dropped
int trace_flags;              // runtime trace bitmask (syscall/disk/fault bits)

void klog_putc(int c) {
  int slot;
  slot = klog_total % CFG_KLOG_SIZE;
  klog_buf[slot] = c;
  if (klog_len < CFG_KLOG_SIZE) {
    klog_len = klog_len + 1;
  }
  klog_total = klog_total + 1;
  serial_putc(c); // mirror to the host serial console
}

void klog(char *s) {
  int i;
  i = 0;
  while (s[i] != 0) {
    klog_putc(s[i]);
    i = i + 1;
  }
}

// Append a signed decimal number to the kernel log (errno returns are negative).
void klog_int(int value) {
  char digits[12];
  int n;
  if (value < 0) {
    klog_putc(45); // '-' (a '-' char literal collides with the minus operator)
    value = 0 - value;
  }
  if (value == 0) {
    klog_putc('0');
    return;
  }
  n = 0;
  while (value > 0) {
    digits[n] = '0' + value % 10;
    value = value / 10;
    n = n + 1;
  }
  while (n > 0) {
    n = n - 1;
    klog_putc(digits[n]);
  }
}

// Copy out a snapshot of the retained kernel log for /dev/kmsg. `off` is the
// byte offset from the oldest retained byte; the caller's page directory is
// live during the read syscall, so the destination is written directly.
int klog_read(int off, int dst, int len) {
  int first;
  int index;
  int take;
  int i;
  if (off < 0 || off >= klog_len) {
    return 0;
  }
  take = klog_len - off;
  if (take > len) {
    take = len;
  }
  i = 0;
  first = klog_total - klog_len;
  while (i < take) {
    index = (first + off + i) % CFG_KLOG_SIZE;
    write8_at(dst + i, klog_buf[index]);
    i = i + 1;
  }
  return take;
}

// Symbolic name for the headline syscalls, or 0 to fall back to the number.
// Keeping a subset bounded avoids a giant table while still making the common
// process/file/memory traffic readable.
char *syscall_name(int num) {
  if (num == CFG_SYS_EXIT) return "exit";
  if (num == CFG_SYS_WRITE) return "write";
  if (num == CFG_SYS_READ) return "read";
  if (num == CFG_SYS_YIELD) return "yield";
  if (num == CFG_SYS_GETPID) return "getpid";
  if (num == CFG_SYS_FORK) return "fork";
  if (num == CFG_SYS_EXEC) return "exec";
  if (num == CFG_SYS_WAIT) return "wait";
  if (num == CFG_SYS_WAITPID) return "waitpid";
  if (num == CFG_SYS_OPEN) return "open";
  if (num == CFG_SYS_CLOSE) return "close";
  if (num == CFG_SYS_PIPE) return "pipe";
  if (num == CFG_SYS_DUP) return "dup";
  if (num == CFG_SYS_GETDENTS) return "getdents";
  if (num == CFG_SYS_STAT) return "stat";
  if (num == CFG_SYS_FSTAT) return "fstat";
  if (num == CFG_SYS_LSEEK) return "lseek";
  if (num == CFG_SYS_BRK) return "brk";
  if (num == CFG_SYS_MMAP) return "mmap";
  if (num == CFG_SYS_MUNMAP) return "munmap";
  if (num == CFG_SYS_KILL) return "kill";
  if (num == CFG_SYS_IOCTL) return "ioctl";
  if (num == CFG_SYS_FCNTL) return "fcntl";
  if (num == CFG_SYS_POLL) return "poll";
  return 0;
}

// Structured syscall trace line: "trace: pid=N name(a1, a2, a3) = rv".
void trace_syscall(int pid, int num, int a1, int a2, int a3, int rv) {
  char *name;
  name = syscall_name(num);
  klog("trace: pid=");
  klog_int(pid);
  klog(" ");
  if (name != 0) {
    klog(name);
  } else {
    klog("sys");
    klog_int(num);
  }
  klog_putc(40); // '(' -- a "(" string literal collides with the open-paren token
  klog_int(a1);
  klog(", ");
  klog_int(a2);
  klog(", ");
  klog_int(a3);
  klog(") = "); // ") = " is not a bare punctuator, so it lexes as a string
  klog_int(rv);
  klog("\n");
}

// Dump the current process context, called from panic() so a fatal stop reports
// who was running and where, both on serial and (until the halt) in the log.
void dump_state(void) {
  klog("kernel: state pid=");
  klog_int(current);
  klog(" pc=");
  klog_int(proc_table[current].ctx.pc);
  klog(" sp=");
  klog_int(proc_table[current].ctx.sp);
  klog(" mode=");
  klog_int(proc_table[current].ctx.mode);
  klog("\n");
}
