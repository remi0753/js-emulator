// Syscall ABI: the trap stub spills the caller's registers into its PCB, and
// this dispatcher decodes R0 (number) / R1-R3 (args), validates user memory,
// updates process state, and sets the R0 return value.
#include "kernel.h"

int g_noret;        // set when a handler set R0 itself (don't overwrite it)
int g_pending_free; // address space to free after switching contexts, or 0
int syscall_table[CFG_NSYS]; // syscall number -> handler address (0 = unimplemented)

int sys_write(int caller, int fd, int buf, int len) {
  char *p;
  int i;
  int base;
  int t;
  int pp;
  int n;
  if (len < 0) {
    return -CFG_EINVAL;
  }
  if (user_access_ok(caller, buf, len, 0) == 0) {
    return -CFG_EFAULT;
  }
  if (fd < 0 || fd >= CFG_NFD) {
    return -CFG_EBADF;
  }
  base = caller * CFG_NFD;
  t = proc_fd_type[base + fd];
  if (t == CFG_FT_CONS) {
    p = buf;
    i = 0;
    while (i < len) {
      serial_putc(p[i]);
      i = i + 1;
    }
    return len;
  }
  if (t == CFG_FT_PIPE && proc_fd_pend[base + fd] == 1) {
    pp = proc_fd_pipe[base + fd];
    if (pipe_nread[pp] == 0) {
      return -CFG_EPIPE; // broken pipe: no readers
    }
    if (pipe_count[pp] == CFG_PIPESZ) {
      g_noret = 1;
      proc_pc[caller] = proc_pc[caller] - CFG_SYSCALL_INSTR_SIZE;
      sleep(caller, &pipe_used[pp]); // wait for a reader to make space
      return 0;
    }
    n = pipe_write_bytes(pp, buf, len);
    wakeup(&pipe_used[pp]); // data available for a blocked reader
    return n;
  }
  return -CFG_EBADF;
}

int sys_read(int caller, int fd, int buf, int len) {
  int base;
  int t;
  int inum;
  int off;
  int got;
  int ch;
  int pp;
  int n;
  if (len < 0) {
    return -CFG_EINVAL;
  }
  if (user_access_ok(caller, buf, len, 1) == 0) {
    return -CFG_EFAULT;
  }
  if (fd < 0 || fd >= CFG_NFD) {
    return -CFG_EBADF;
  }
  base = caller * CFG_NFD;
  t = proc_fd_type[base + fd];
  if (t == CFG_FT_KBD) {
    if (len == 0) {
      return 0;
    }
    ch = kbd_getc();
    if (ch == 0) {
      if (kbd_eof()) {
        return 0;
      }
      g_noret = 1;
      proc_pc[caller] = proc_pc[caller] - CFG_SYSCALL_INSTR_SIZE;
      sleep(caller, &kbd_chan); // wait for the keyboard IRQ to deliver input
      return 0;
    }
    write8_at(buf, ch);
    return 1;
  }
  if (t == CFG_FT_FILE) {
    inum = proc_fd_inum[base + fd];
    off = proc_fd_off[base + fd];
    got = readi(inum, off, len, buf);
    proc_fd_off[base + fd] = off + got;
    return got;
  }
  if (t == CFG_FT_PIPE && proc_fd_pend[base + fd] == 0) {
    pp = proc_fd_pipe[base + fd];
    if (pipe_count[pp] > 0) {
      n = pipe_read_bytes(pp, buf, len);
      wakeup(&pipe_used[pp]); // space freed for a blocked writer
      return n;
    }
    if (pipe_nwrite[pp] == 0) {
      return 0; // EOF: no data and no writers
    }
    // Block: rewind to re-execute INT 0x80 when a writer wakes us.
    g_noret = 1;
    proc_pc[caller] = proc_pc[caller] - CFG_SYSCALL_INSTR_SIZE;
    sleep(caller, &pipe_used[pp]);
    return 0;
  }
  return -CFG_EBADF;
}

int sys_open(int caller, int upath, int flags) {
  int inum;
  int t;
  int fd;
  int base;
  if (copy_path_in(caller, upath) < 0) {
    return -CFG_EFAULT;
  }
  inum = namei(kpath);
  if (inum == 0) {
    return -CFG_ENOENT;
  }
  t = inode_type(inum);
  if (t != CFG_T_FILE && t != CFG_T_DIR) {
    return -CFG_EINVAL;
  }
  fd = alloc_fd(caller);
  if (fd < 0) {
    return -CFG_EMFILE;
  }
  base = caller * CFG_NFD;
  proc_fd_type[base + fd] = CFG_FT_FILE;
  proc_fd_inum[base + fd] = inum;
  proc_fd_off[base + fd] = 0;
  return fd;
}

int sys_close(int caller, int fd) {
  if (fd < 0 || fd >= CFG_NFD) {
    return -CFG_EBADF;
  }
  if (proc_fd_type[caller * CFG_NFD + fd] == CFG_FT_NONE) {
    return -CFG_EBADF;
  }
  fd_close(caller, fd); // wakes blocked pipe peers when releasing a pipe end
  return 0;
}

int sys_pipe(int caller, int ufds) {
  int pp;
  int rfd;
  int wfd;
  int base;
  int fds[2];
  if (user_access_ok(caller, ufds, 8, 1) == 0) {
    return -CFG_EFAULT;
  }
  pp = alloc_pipe();
  if (pp < 0) {
    return -CFG_ENFILE;
  }
  base = caller * CFG_NFD;
  rfd = alloc_fd(caller);
  if (rfd < 0) {
    pipe_used[pp] = 0;
    return -CFG_EMFILE;
  }
  proc_fd_type[base + rfd] = CFG_FT_PIPE;
  proc_fd_pipe[base + rfd] = pp;
  proc_fd_pend[base + rfd] = 0;
  wfd = alloc_fd(caller);
  if (wfd < 0) {
    proc_fd_type[base + rfd] = CFG_FT_NONE;
    pipe_used[pp] = 0;
    return -CFG_EMFILE;
  }
  proc_fd_type[base + wfd] = CFG_FT_PIPE;
  proc_fd_pipe[base + wfd] = pp;
  proc_fd_pend[base + wfd] = 1;
  fds[0] = rfd;
  fds[1] = wfd;
  copyout(caller, ufds, fds, 8); // already validated above; cannot fault here
  return 0;
}

int sys_dup(int caller, int oldfd) {
  int base;
  int t;
  int newfd;
  int pp;
  if (oldfd < 0 || oldfd >= CFG_NFD) {
    return -CFG_EBADF;
  }
  base = caller * CFG_NFD;
  t = proc_fd_type[base + oldfd];
  if (t == CFG_FT_NONE) {
    return -CFG_EBADF;
  }
  newfd = alloc_fd(caller);
  if (newfd < 0) {
    return -CFG_EMFILE;
  }
  proc_fd_type[base + newfd] = t;
  proc_fd_inum[base + newfd] = proc_fd_inum[base + oldfd];
  proc_fd_off[base + newfd] = proc_fd_off[base + oldfd];
  proc_fd_pipe[base + newfd] = proc_fd_pipe[base + oldfd];
  proc_fd_pend[base + newfd] = proc_fd_pend[base + oldfd];
  if (t == CFG_FT_PIPE) {
    pp = proc_fd_pipe[base + oldfd];
    if (proc_fd_pend[base + oldfd] == 1) {
      pipe_nwrite[pp] = pipe_nwrite[pp] + 1;
    } else {
      pipe_nread[pp] = pipe_nread[pp] + 1;
    }
  }
  return newfd;
}

// --- syscall handlers ---
//
// Every handler has the same signature h(caller, a1, a2, a3) and returns the
// value to place in R0, EXCEPT when it sets R0 itself or blocks the caller, in
// which case it sets g_noret. A handler that must free an address space after
// the context switch stages it in g_pending_free. These uniform shapes let the
// dispatcher index a table by syscall number instead of a long if/else chain.

int h_exit(int caller, int a1, int a2, int a3) {
  g_pending_free = do_exit(caller, a1);
  g_noret = 1; // the caller is now a zombie; don't write its R0
  switch_to_next();
  return 0;
}

int h_write(int caller, int a1, int a2, int a3) {
  return sys_write(caller, a1, a2, a3);
}

int h_read(int caller, int a1, int a2, int a3) {
  return sys_read(caller, a1, a2, a3);
}

int h_yield(int caller, int a1, int a2, int a3) {
  switch_to_next();
  return 0; // the caller resumes with R0 = 0 when next scheduled
}

int h_getpid(int caller, int a1, int a2, int a3) {
  return caller;
}

int h_fork(int caller, int a1, int a2, int a3) {
  return do_fork(caller);
}

int h_exec(int caller, int a1, int a2, int a3) {
  g_pending_free = do_exec(caller, a1, a2);
  g_noret = 1; // do_exec set R0 (argc on success, -errno on failure)
  return 0;
}

int h_wait(int caller, int a1, int a2, int a3) {
  g_pending_free = do_wait(caller);
  g_noret = 1; // do_wait set R0 (child pid / -ECHILD) or blocked the caller
  return 0;
}

int h_open(int caller, int a1, int a2, int a3) {
  return sys_open(caller, a1, a2);
}

int h_close(int caller, int a1, int a2, int a3) {
  return sys_close(caller, a1);
}

int h_pipe(int caller, int a1, int a2, int a3) {
  return sys_pipe(caller, a1);
}

int h_dup(int caller, int a1, int a2, int a3) {
  return sys_dup(caller, a1);
}

int h_time(int caller, int a1, int a2, int a3) {
  return rtc_time();
}

int h_shutdown(int caller, int a1, int a2, int a3) {
  serial_write("kernel: shutdown\n");
  power_off(); // the machine stops at the next instruction boundary
  return 0;
}

// Install the handler addresses. Unlisted numbers (e.g. UPTIME) stay 0 and
// dispatch as -ENOSYS.
void syscall_init(void) {
  int i;
  i = 0;
  while (i < CFG_NSYS) {
    syscall_table[i] = 0;
    i = i + 1;
  }
  syscall_table[CFG_SYS_EXIT] = h_exit;
  syscall_table[CFG_SYS_WRITE] = h_write;
  syscall_table[CFG_SYS_READ] = h_read;
  syscall_table[CFG_SYS_YIELD] = h_yield;
  syscall_table[CFG_SYS_GETPID] = h_getpid;
  syscall_table[CFG_SYS_FORK] = h_fork;
  syscall_table[CFG_SYS_EXEC] = h_exec;
  syscall_table[CFG_SYS_WAIT] = h_wait;
  syscall_table[CFG_SYS_OPEN] = h_open;
  syscall_table[CFG_SYS_CLOSE] = h_close;
  syscall_table[CFG_SYS_PIPE] = h_pipe;
  syscall_table[CFG_SYS_DUP] = h_dup;
  syscall_table[CFG_SYS_TIME] = h_time;
  syscall_table[CFG_SYS_SHUTDOWN] = h_shutdown;
}

void on_syscall(void) {
  int caller;
  int num;
  int a1;
  int a2;
  int a3;
  int rv;
  if (sctx_mode != CFG_MODE_USER) {
    panic("syscall outside user");
  }
  g_noret = 0;
  g_pending_free = 0;
  caller = current;
  save_ctx(caller);
  num = proc_regs[caller * 8 + 0];
  a1 = proc_regs[caller * 8 + 1];
  a2 = proc_regs[caller * 8 + 2];
  a3 = proc_regs[caller * 8 + 3];

  if (num >= 0 && num < CFG_NSYS && syscall_table[num] != 0) {
    rv = syscall_table[num](caller, a1, a2, a3);
    if (g_noret == 0) {
      proc_regs[caller * 8 + 0] = rv;
    }
  } else {
    proc_regs[caller * 8 + 0] = -CFG_ENOSYS;
  }

  load_ctx(current);
  __lptbr(proc_ptbr[current]);
  if (g_pending_free != 0) {
    free_space(g_pending_free);
  }
}
