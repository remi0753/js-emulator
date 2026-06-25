// Syscall ABI: the trap stub spills the caller's registers into its PCB, and
// this dispatcher decodes R0 (number) / R1-R3 (args), validates user memory,
// updates process state, and sets the R0 return value.
#include "kernel.h"

int g_noret;        // set when a handler set R0 itself (don't overwrite it)
int g_pending_free; // address space to free after switching contexts, or 0
syscall_fn syscall_table[CFG_NSYS]; // syscall number -> handler (0 = unimplemented)

int sys_write(int caller, int fd, int buf, int len) {
  if (len < 0) {
    return -CFG_EINVAL;
  }
  if (user_access_ok(caller, buf, len, 0) == 0) {
    return -CFG_EFAULT;
  }
  if (fd < 0 || fd >= CFG_NFD) {
    return -CFG_EBADF;
  }
  return file_write(&proc_table[caller].files[fd], caller, buf, len);
}

int sys_read(int caller, int fd, int buf, int len) {
  if (len < 0) {
    return -CFG_EINVAL;
  }
  if (user_access_ok(caller, buf, len, 1) == 0) {
    return -CFG_EFAULT;
  }
  if (fd < 0 || fd >= CFG_NFD) {
    return -CFG_EBADF;
  }
  return file_read(&proc_table[caller].files[fd], caller, buf, len);
}

int sys_open(int caller, int upath, int flags) {
  struct vnode node;
  int result;
  int t;
  int fd;
  result = copy_path_in(caller, upath);
  if (result < 0) {
    return result;
  }
  result = vfs_lookup(kpath, 1, caller, &node);
  if (result < 0) {
    if ((flags & CFG_O_CREATE) == 0) {
      return result;
    }
    if (result != -CFG_ENOENT) return result;
    result = vfs_create(kpath, CFG_T_FILE, 438, caller, &node);
    if (result < 0) return result;
  }
  t = node.inode.type;
  if (t != CFG_T_FILE && t != CFG_T_DIR) {
    return -CFG_EINVAL;
  }
  if (t == CFG_T_DIR && (flags & CFG_O_ACCMODE) != 0) {
    return -CFG_EISDIR;
  }
  if ((flags & CFG_O_ACCMODE) == CFG_O_WRONLY) {
    if (vnode_access(&node, proc_table[caller].uid,
        proc_table[caller].gid, 2) == 0) return -CFG_EACCES;
  } else if ((flags & CFG_O_ACCMODE) == CFG_O_RDWR) {
    if (vnode_access(&node, proc_table[caller].uid,
        proc_table[caller].gid, 6) == 0) return -CFG_EACCES;
  } else if (vnode_access(&node, proc_table[caller].uid,
      proc_table[caller].gid, 4) == 0) {
    return -CFG_EACCES;
  }
  if ((flags & CFG_O_TRUNC) != 0) {
    if ((flags & CFG_O_ACCMODE) == 0) return -CFG_EINVAL;
    result = vnode_truncate(&node);
    if (result < 0) return result;
  }
  fd = alloc_fd(caller);
  if (fd < 0) {
    return -CFG_EMFILE;
  }
  if (file_set_node(&proc_table[caller].files[fd], &node) < 0) {
    return -CFG_ENFILE;
  }
  proc_table[caller].files[fd].status_flags = flags;
  if ((flags & CFG_O_ACCMODE) == CFG_O_WRONLY) {
    proc_table[caller].files[fd].readable = 0;
    proc_table[caller].files[fd].writable = 1;
  } else if ((flags & CFG_O_ACCMODE) == CFG_O_RDWR) {
    proc_table[caller].files[fd].readable = 1;
    proc_table[caller].files[fd].writable = 1;
  }
  return fd;
}

int sys_close(int caller, int fd) {
  if (fd < 0 || fd >= CFG_NFD) {
    return -CFG_EBADF;
  }
  if (proc_table[caller].files[fd].type == CFG_FT_NONE) {
    return -CFG_EBADF;
  }
  fd_close(caller, fd); // wakes blocked pipe peers when releasing a pipe end
  return 0;
}

int sys_pipe(int caller, int ufds) {
  int pp;
  int rfd;
  int wfd;
  int fds[2];
  if (user_access_ok(caller, ufds, 8, 1) == 0) {
    return -CFG_EFAULT;
  }
  pp = alloc_pipe();
  if (pp < 0) {
    return -CFG_ENFILE;
  }
  rfd = alloc_fd(caller);
  if (rfd < 0) {
    pipe_table[pp].used = 0;
    return -CFG_EMFILE;
  }
  file_set_pipe(&proc_table[caller].files[rfd], pp, 0);
  wfd = alloc_fd(caller);
  if (wfd < 0) {
    file_reset(&proc_table[caller].files[rfd]);
    pipe_table[pp].used = 0;
    return -CFG_EMFILE;
  }
  file_set_pipe(&proc_table[caller].files[wfd], pp, 1);
  fds[0] = rfd;
  fds[1] = wfd;
  copyout(caller, ufds, fds, 8); // already validated above; cannot fault here
  return 0;
}

int sys_dup(int caller, int oldfd) {
  int newfd;
  if (oldfd < 0 || oldfd >= CFG_NFD) {
    return -CFG_EBADF;
  }
  if (proc_table[caller].files[oldfd].type == CFG_FT_NONE) {
    return -CFG_EBADF;
  }
  newfd = alloc_fd(caller);
  if (newfd < 0) {
    return -CFG_EMFILE;
  }
  copy_file(&proc_table[caller].files[newfd], &proc_table[caller].files[oldfd]);
  proc_table[caller].files[newfd].fd_flags = 0;
  return newfd;
}

int sys_fcntl(int caller, int fd, int command, int argument) {
  int newfd;
  if (fd < 0 || fd >= CFG_NFD ||
      proc_table[caller].files[fd].type == CFG_FT_NONE) {
    return -CFG_EBADF;
  }
  if (command == CFG_F_DUPFD) {
    newfd = alloc_fd_from(caller, argument);
    if (newfd < 0) {
      return -CFG_EMFILE;
    }
    copy_file(&proc_table[caller].files[newfd],
      &proc_table[caller].files[fd]);
    proc_table[caller].files[newfd].fd_flags = 0;
    return newfd;
  }
  if (command == CFG_F_GETFD) {
    return proc_table[caller].files[fd].fd_flags;
  }
  if (command == CFG_F_SETFD) {
    proc_table[caller].files[fd].fd_flags = argument & CFG_FD_CLOEXEC;
    return 0;
  }
  if (command == CFG_F_GETFL) {
    return proc_table[caller].files[fd].status_flags;
  }
  if (command == CFG_F_SETFL) {
    proc_table[caller].files[fd].status_flags =
      (proc_table[caller].files[fd].status_flags & CFG_O_ACCMODE) |
      (argument & CFG_O_NONBLOCK);
    return 0;
  }
  return -CFG_EINVAL;
}

int sys_ioctl(int caller, int fd, int request, int argument) {
  int pgid;
  if (fd < 0 || fd >= CFG_NFD ||
      proc_table[caller].files[fd].type == CFG_FT_NONE) {
    return -CFG_EBADF;
  }
  if (file_is_tty(&proc_table[caller].files[fd]) == 0) {
    return -CFG_ENOTTY;
  }
  if (request == CFG_TIOCGPGRP) {
    pgid = tty_get_foreground();
    if (copyout(caller, argument, &pgid, 4) < 0) {
      return -CFG_EFAULT;
    }
    return 0;
  }
  if (request == CFG_TIOCSPGRP) {
    if (copyin(caller, &pgid, argument, 4) < 0) {
      return -CFG_EFAULT;
    }
    return tty_set_foreground(caller, pgid);
  }
  if (request == CFG_TCGETS) {
    return tty_getattr(caller, argument);
  }
  if (request == CFG_TCSETS || request == CFG_TCSETSW) {
    return tty_setattr(caller, argument, 0);
  }
  if (request == CFG_TCSETSF) {
    return tty_setattr(caller, argument, 1);
  }
  if (request == CFG_TIOCGWINSZ) {
    return tty_getwinsize(caller, argument);
  }
  if (request == CFG_TIOCSWINSZ) {
    return tty_setwinsize(caller, argument);
  }
  return -CFG_ENOTTY;
}

int sys_getdents(int caller, int fd, int destination, int count) {
  if (count < 0) {
    return -CFG_EINVAL;
  }
  if (user_access_ok(caller, destination, count, 1) == 0) {
    return -CFG_EFAULT;
  }
  if (fd < 0 || fd >= CFG_NFD) {
    return -CFG_EBADF;
  }
  return file_getdents(&proc_table[caller].files[fd],
    caller, destination, count);
}

int sys_stat_path(int caller, int upath, int destination, int follow) {
  struct vnode node;
  struct guest_stat value;
  int result;
  result = copy_path_in(caller, upath);
  if (result < 0) return result;
  result = vfs_lookup(kpath, follow, caller, &node);
  if (result < 0) return result;
  vnode_stat(&node, &value);
  return copyout(caller, destination, &value, sizeof(struct guest_stat));
}

int sys_fstat(int caller, int fd, int destination) {
  struct guest_stat value;
  int result;
  if (fd < 0 || fd >= CFG_NFD ||
      proc_table[caller].files[fd].type == CFG_FT_NONE) {
    return -CFG_EBADF;
  }
  result = file_stat(&proc_table[caller].files[fd], &value);
  if (result < 0) return result;
  return copyout(caller, destination, &value, sizeof(struct guest_stat));
}

int sys_chmod(int caller, int upath, int mode) {
  int result;
  result = copy_path_in(caller, upath);
  if (result < 0) return result;
  return vfs_chmod(kpath, mode, caller);
}

int sys_chown(int caller, int upath, int uid, int gid) {
  int result;
  if (proc_table[caller].uid != 0) return -CFG_EPERM;
  result = copy_path_in(caller, upath);
  if (result < 0) return result;
  return vfs_chown(kpath, uid, gid, caller);
}

int sys_mkdir(int caller, int upath, int mode) {
  int result;
  result = copy_path_in(caller, upath);
  if (result < 0) return result;
  {
    struct vnode node;
    result = vfs_create(kpath, CFG_T_DIR, mode, caller, &node);
  }
  if (result < 0) return result;
  return 0;
}

int sys_remove_path(int caller, int upath, int remove_dir) {
  int result;
  result = copy_path_in(caller, upath);
  if (result < 0) return result;
  return vfs_unlink(kpath, remove_dir, caller);
}

int copy_second_path(int caller, int upath, int destination) {
  return copyinstr(caller, destination, upath, CFG_INITPATH_LEN);
}

int sys_link(int caller, int uold, int unew) {
  char oldpath[CFG_INITPATH_LEN];
  char newpath[CFG_INITPATH_LEN];
  int result;
  result = copy_second_path(caller, uold, oldpath);
  if (result < 0) return result;
  result = copy_second_path(caller, unew, newpath);
  if (result < 0) return result;
  return vfs_link(oldpath, newpath);
}

int sys_rename(int caller, int uold, int unew) {
  char oldpath[CFG_INITPATH_LEN];
  char newpath[CFG_INITPATH_LEN];
  int result;
  result = copy_second_path(caller, uold, oldpath);
  if (result < 0) return result;
  result = copy_second_path(caller, unew, newpath);
  if (result < 0) return result;
  return vfs_rename(oldpath, newpath);
}

int sys_symlink(int caller, int utarget, int ulink) {
  char target[CFG_INITPATH_LEN];
  char linkpath[CFG_INITPATH_LEN];
  int result;
  result = copy_second_path(caller, utarget, target);
  if (result < 0) return result;
  result = copy_second_path(caller, ulink, linkpath);
  if (result < 0) return result;
  return vfs_symlink(target, linkpath);
}

int sys_readlink(int caller, int upath, int destination, int size) {
  char value[CFG_INITPATH_LEN];
  int result;
  if (size < 0) return -CFG_EINVAL;
  result = copy_path_in(caller, upath);
  if (result < 0) return result;
  if (size > CFG_INITPATH_LEN) size = CFG_INITPATH_LEN;
  result = vfs_readlink(kpath, caller, value, size);
  if (result < 0) return result;
  if (copyout(caller, destination, value, result) < 0) return -CFG_EFAULT;
  return result;
}

int sys_lseek(int caller, int fd, int offset, int whence) {
  if (fd < 0 || fd >= CFG_NFD ||
      proc_table[caller].files[fd].type == CFG_FT_NONE) {
    return -CFG_EBADF;
  }
  return file_lseek(&proc_table[caller].files[fd], offset, whence);
}

int copy_fixed_string(int destination, int source, int size) {
  int i;
  int c;
  i = 0;
  while (i < size) {
    c = 0;
    if (i < size - 1) {
      c = read8_at(source + i);
    }
    write8_at(destination + i, c);
    if (c == 0) {
      i = i + 1;
      while (i < size) {
        write8_at(destination + i, 0);
        i = i + 1;
      }
      return 0;
    }
    i = i + 1;
  }
  return 0;
}

int sys_uname(int caller, int destination) {
  char value[192];
  memset(value, 0, 192);
  copy_fixed_string(value, "jscpu-os", 32);
  copy_fixed_string(value + 32, "jscpu", 32);
  copy_fixed_string(value + 64, "0.4", 32);
  copy_fixed_string(value + 96, "phase21", 32);
  copy_fixed_string(value + 128, "custom32", 32);
  copy_fixed_string(value + 160, "local", 32);
  return copyout(caller, destination, value, 192);
}

int sys_gettimeofday(int caller, int destination, int timezone) {
  int value[2];
  if (timezone != 0) {
    return -CFG_EINVAL;
  }
  value[0] = rtc_time();
  value[1] = (ticks % CFG_TICKS_PER_SEC) *
    (1000000 / CFG_TICKS_PER_SEC);
  return copyout(caller, destination, value, 8);
}

int sys_clock_gettime(int caller, int clock_id, int destination) {
  int value[2];
  if (clock_id == CFG_CLOCK_REALTIME) {
    value[0] = rtc_time();
    value[1] = (ticks % CFG_TICKS_PER_SEC) *
      (1000000000 / CFG_TICKS_PER_SEC);
  } else if (clock_id == CFG_CLOCK_MONOTONIC) {
    value[0] = ticks / CFG_TICKS_PER_SEC;
    value[1] = (ticks % CFG_TICKS_PER_SEC) *
      (1000000000 / CFG_TICKS_PER_SEC);
  } else {
    return -CFG_EINVAL;
  }
  return copyout(caller, destination, value, 8);
}

int sys_nanosleep(int caller, int request, int remaining) {
  int value[2];
  int delay;
  if (copyin(caller, value, request, 8) < 0) {
    return -CFG_EFAULT;
  }
  if (value[0] < 0 || value[0] > 1000000 ||
      value[1] < 0 || value[1] >= 1000000000) {
    return -CFG_EINVAL;
  }
  delay = value[0] * CFG_TICKS_PER_SEC;
  delay = delay + (value[1] +
    (1000000000 / CFG_TICKS_PER_SEC) - 1) /
    (1000000000 / CFG_TICKS_PER_SEC);
  if (delay == 0) {
    return 0;
  }
  proc_table[caller].sleep_deadline = ticks + delay;
  proc_table[caller].sleep_remaining = remaining;
  g_noret = 1;
  sleep(caller, &proc_table[caller].sleep_deadline);
  return 0;
}

int poll_chan;

void poll_wakeup(void) {
  wakeup(&poll_chan);
}

int sys_poll(int caller, int ufds, int count, int timeout) {
  struct guest_pollfd value;
  struct file *file;
  int i;
  int ready;
  int mask;
  int delay;
  if (count < 0 || count > CFG_NFD || timeout < -1) return -CFG_EINVAL;
  if (count > 0 &&
      user_access_ok(caller, ufds, count * sizeof(struct guest_pollfd), 1) == 0) {
    return -CFG_EFAULT;
  }
  ready = 0;
  i = 0;
  while (i < count) {
    if (copyin(caller, &value,
        ufds + i * sizeof(struct guest_pollfd),
        sizeof(struct guest_pollfd)) < 0) return -CFG_EFAULT;
    value.revents = 0;
    if (value.fd >= 0) {
      if (value.fd >= CFG_NFD ||
          proc_table[caller].files[value.fd].type == CFG_FT_NONE) {
        value.revents = CFG_POLLNVAL;
      } else {
        file = &proc_table[caller].files[value.fd];
        mask = value.events | CFG_POLLERR | CFG_POLLHUP;
        value.revents = file_poll(file, mask);
      }
      if (value.revents != 0) ready = ready + 1;
    }
    if (copyout(caller, ufds + i * sizeof(struct guest_pollfd),
        &value, sizeof(struct guest_pollfd)) < 0) return -CFG_EFAULT;
    i = i + 1;
  }
  if (ready > 0 || timeout == 0) {
    proc_table[caller].poll_deadline = 0;
    proc_table[caller].sleep_deadline = 0;
    return ready;
  }
  if (timeout > 0) {
    if (proc_table[caller].poll_deadline == 0) {
      delay = (timeout * CFG_TICKS_PER_SEC + 999) / 1000;
      if (delay < 1) delay = 1;
      proc_table[caller].poll_deadline = ticks + delay;
    }
    if (ticks >= proc_table[caller].poll_deadline) {
      proc_table[caller].poll_deadline = 0;
      proc_table[caller].sleep_deadline = 0;
      return 0;
    }
    proc_table[caller].sleep_deadline = proc_table[caller].poll_deadline;
  } else {
    proc_table[caller].sleep_deadline = 0;
  }
  g_noret = 1;
  proc_table[caller].ctx.pc =
    proc_table[caller].ctx.pc - CFG_SYSCALL_INSTR_SIZE;
  sleep(caller, &poll_chan);
  return 0;
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

int h_getppid(int caller, int a1, int a2, int a3) {
  if (proc_table[caller].parent < 0) {
    return 0;
  }
  return proc_table[caller].parent;
}

int h_fork(int caller, int a1, int a2, int a3) {
  return do_fork(caller);
}

int h_exec(int caller, int a1, int a2, int a3) {
  g_pending_free = do_exec(caller, a1, a2, a3);
  g_noret = 1; // do_exec set R0 (argc on success, -errno on failure)
  return 0;
}

int h_wait(int caller, int a1, int a2, int a3) {
  g_pending_free = do_waitpid(caller, -1, a1, 0);
  g_noret = 1; // do_wait set R0 (child pid / -ECHILD) or blocked the caller
  return 0;
}

int h_waitpid(int caller, int a1, int a2, int a3) {
  g_pending_free = do_waitpid(caller, a1, a2, a3);
  g_noret = 1;
  return 0;
}

int h_kill(int caller, int a1, int a2, int a3) {
  return send_signal_selector(caller, a1, a2);
}

int h_sigaction(int caller, int a1, int a2, int a3) {
  return sys_sigaction(caller, a1, a2, a3);
}

int h_sigprocmask(int caller, int a1, int a2, int a3) {
  return sys_sigprocmask(caller, a1, a2, a3);
}

int h_sigreturn(int caller, int a1, int a2, int a3) {
  int result;
  result = sys_sigreturn(caller);
  if (result == 0) {
    g_noret = 1;
  }
  return result;
}

int h_setpgid(int caller, int a1, int a2, int a3) {
  return sys_setpgid(caller, a1, a2);
}

int h_setsid(int caller, int a1, int a2, int a3) {
  return sys_setsid(caller);
}

int h_tcsetpgrp(int caller, int a1, int a2, int a3) {
  return tty_set_foreground(caller, a1);
}

int h_tcgetpgrp(int caller, int a1, int a2, int a3) {
  return tty_get_foreground();
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

int h_uptime(int caller, int a1, int a2, int a3) {
  return ticks;
}

int h_nanosleep(int caller, int a1, int a2, int a3) {
  return sys_nanosleep(caller, a1, a2);
}

int h_brk(int caller, int a1, int a2, int a3) {
  return vm_brk(caller, a1);
}

int h_mmap(int caller, int a1, int a2, int a3) {
  return vm_mmap(caller, a1);
}

int h_munmap(int caller, int a1, int a2, int a3) {
  return vm_munmap(caller, a1, a2);
}

int h_mprotect(int caller, int a1, int a2, int a3) {
  return vm_mprotect(caller, a1, a2, a3);
}

int h_fcntl(int caller, int a1, int a2, int a3) {
  return sys_fcntl(caller, a1, a2, a3);
}

int h_ioctl(int caller, int a1, int a2, int a3) {
  return sys_ioctl(caller, a1, a2, a3);
}

int h_gettimeofday(int caller, int a1, int a2, int a3) {
  return sys_gettimeofday(caller, a1, a2);
}

int h_clock_gettime(int caller, int a1, int a2, int a3) {
  return sys_clock_gettime(caller, a1, a2);
}

int h_uname(int caller, int a1, int a2, int a3) {
  return sys_uname(caller, a1);
}

int h_getdents(int caller, int a1, int a2, int a3) {
  return sys_getdents(caller, a1, a2, a3);
}

int h_stat(int caller, int a1, int a2, int a3) {
  return sys_stat_path(caller, a1, a2, 1);
}

int h_fstat(int caller, int a1, int a2, int a3) {
  return sys_fstat(caller, a1, a2);
}

int h_lstat(int caller, int a1, int a2, int a3) {
  return sys_stat_path(caller, a1, a2, 0);
}

int h_chmod(int caller, int a1, int a2, int a3) {
  return sys_chmod(caller, a1, a2);
}

int h_chown(int caller, int a1, int a2, int a3) {
  return sys_chown(caller, a1, a2, a3);
}

int h_mkdir(int caller, int a1, int a2, int a3) {
  return sys_mkdir(caller, a1, a2);
}

int h_rmdir(int caller, int a1, int a2, int a3) {
  return sys_remove_path(caller, a1, 1);
}

int h_unlink(int caller, int a1, int a2, int a3) {
  return sys_remove_path(caller, a1, 0);
}

int h_link(int caller, int a1, int a2, int a3) {
  return sys_link(caller, a1, a2);
}

int h_rename(int caller, int a1, int a2, int a3) {
  return sys_rename(caller, a1, a2);
}

int h_symlink(int caller, int a1, int a2, int a3) {
  return sys_symlink(caller, a1, a2);
}

int h_readlink(int caller, int a1, int a2, int a3) {
  return sys_readlink(caller, a1, a2, a3);
}

int h_lseek(int caller, int a1, int a2, int a3) {
  return sys_lseek(caller, a1, a2, a3);
}

int h_getuid(int caller, int a1, int a2, int a3) {
  return proc_table[caller].uid;
}

int h_getgid(int caller, int a1, int a2, int a3) {
  return proc_table[caller].gid;
}

int h_poll(int caller, int a1, int a2, int a3) {
  return sys_poll(caller, a1, a2, a3);
}

int h_socket(int caller, int a1, int a2, int a3) {
  return socket_create(caller, a1, a2, a3);
}

int h_bind(int caller, int a1, int a2, int a3) {
  return socket_bind(caller, a1, a2, a3);
}

int h_listen(int caller, int a1, int a2, int a3) {
  return socket_listen(caller, a1, a2);
}

int h_accept(int caller, int a1, int a2, int a3) {
  return socket_accept(caller, a1, a2, a3);
}

int h_connect(int caller, int a1, int a2, int a3) {
  return socket_connect(caller, a1, a2, a3);
}

int h_send(int caller, int a1, int a2, int a3) {
  return socket_send(caller, a1, a2, a3);
}

int h_recv(int caller, int a1, int a2, int a3) {
  return socket_recv(caller, a1, a2, a3);
}

int h_setsockopt(int caller, int a1, int a2, int a3) {
  return socket_setsockopt(caller, a1, a2);
}

int h_sendto(int caller, int a1, int a2, int a3) {
  return socket_sendto(caller, a1, a2);
}

int h_recvfrom(int caller, int a1, int a2, int a3) {
  return socket_recvfrom(caller, a1, a2);
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
  syscall_table[CFG_SYS_UPTIME] = h_uptime;
  syscall_table[CFG_SYS_TIME] = h_time;
  syscall_table[CFG_SYS_SHUTDOWN] = h_shutdown;
  syscall_table[CFG_SYS_KILL] = h_kill;
  syscall_table[CFG_SYS_SIGACTION] = h_sigaction;
  syscall_table[CFG_SYS_SIGPROCMASK] = h_sigprocmask;
  syscall_table[CFG_SYS_SIGRETURN] = h_sigreturn;
  syscall_table[CFG_SYS_WAITPID] = h_waitpid;
  syscall_table[CFG_SYS_SETPGID] = h_setpgid;
  syscall_table[CFG_SYS_SETSID] = h_setsid;
  syscall_table[CFG_SYS_TCSETPGRP] = h_tcsetpgrp;
  syscall_table[CFG_SYS_TCGETPGRP] = h_tcgetpgrp;
  syscall_table[CFG_SYS_GETPPID] = h_getppid;
  syscall_table[CFG_SYS_NANOSLEEP] = h_nanosleep;
  syscall_table[CFG_SYS_BRK] = h_brk;
  syscall_table[CFG_SYS_MMAP] = h_mmap;
  syscall_table[CFG_SYS_MUNMAP] = h_munmap;
  syscall_table[CFG_SYS_MPROTECT] = h_mprotect;
  syscall_table[CFG_SYS_FCNTL] = h_fcntl;
  syscall_table[CFG_SYS_IOCTL] = h_ioctl;
  syscall_table[CFG_SYS_GETTIMEOFDAY] = h_gettimeofday;
  syscall_table[CFG_SYS_CLOCK_GETTIME] = h_clock_gettime;
  syscall_table[CFG_SYS_UNAME] = h_uname;
  syscall_table[CFG_SYS_GETDENTS] = h_getdents;
  syscall_table[CFG_SYS_STAT] = h_stat;
  syscall_table[CFG_SYS_FSTAT] = h_fstat;
  syscall_table[CFG_SYS_LSTAT] = h_lstat;
  syscall_table[CFG_SYS_CHMOD] = h_chmod;
  syscall_table[CFG_SYS_CHOWN] = h_chown;
  syscall_table[CFG_SYS_MKDIR] = h_mkdir;
  syscall_table[CFG_SYS_RMDIR] = h_rmdir;
  syscall_table[CFG_SYS_UNLINK] = h_unlink;
  syscall_table[CFG_SYS_LINK] = h_link;
  syscall_table[CFG_SYS_RENAME] = h_rename;
  syscall_table[CFG_SYS_SYMLINK] = h_symlink;
  syscall_table[CFG_SYS_READLINK] = h_readlink;
  syscall_table[CFG_SYS_LSEEK] = h_lseek;
  syscall_table[CFG_SYS_GETUID] = h_getuid;
  syscall_table[CFG_SYS_GETGID] = h_getgid;
  syscall_table[CFG_SYS_POLL] = h_poll;
  syscall_table[CFG_SYS_SOCKET] = h_socket;
  syscall_table[CFG_SYS_BIND] = h_bind;
  syscall_table[CFG_SYS_LISTEN] = h_listen;
  syscall_table[CFG_SYS_ACCEPT] = h_accept;
  syscall_table[CFG_SYS_CONNECT] = h_connect;
  syscall_table[CFG_SYS_SEND] = h_send;
  syscall_table[CFG_SYS_RECV] = h_recv;
  syscall_table[CFG_SYS_SETSOCKOPT] = h_setsockopt;
  syscall_table[CFG_SYS_SENDTO] = h_sendto;
  syscall_table[CFG_SYS_RECVFROM] = h_recvfrom;
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
  num = proc_table[caller].ctx.regs[0];
  a1 = proc_table[caller].ctx.regs[1];
  a2 = proc_table[caller].ctx.regs[2];
  a3 = proc_table[caller].ctx.regs[3];

  if (num >= 0 && num < CFG_NSYS && syscall_table[num] != 0) {
    rv = syscall_table[num](caller, a1, a2, a3);
    if (g_noret == 0) {
      proc_table[caller].ctx.regs[0] = rv;
    }
  } else {
    proc_table[caller].ctx.regs[0] = -CFG_ENOSYS;
  }

  prepare_signal(current);
  load_ctx(current);
  __lptbr(proc_table[current].vm.ptbr);
  if (g_pending_free != 0) {
    free_space(g_pending_free);
  }
}
