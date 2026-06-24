// Unified per-process file-descriptor table. Each fd has a type and, depending
// on the type, an inode + offset (files) or a pipe id + end (pipes).
#include "kernel.h"

int proc_fd_type[CFG_FD_TABLE_LEN]; // none / console / keyboard / file / pipe
int proc_fd_inum[CFG_FD_TABLE_LEN];
int proc_fd_off[CFG_FD_TABLE_LEN];
int proc_fd_pipe[CFG_FD_TABLE_LEN];
int proc_fd_pend[CFG_FD_TABLE_LEN]; // pipe end: 0 = read, 1 = write

void init_fds(int idx) {
  int base;
  int fd;
  base = idx * CFG_NFD;
  fd = 0;
  while (fd < CFG_NFD) {
    proc_fd_type[base + fd] = CFG_FT_NONE;
    fd = fd + 1;
  }
  proc_fd_type[base + 0] = CFG_FT_KBD; // stdin
  proc_fd_type[base + 1] = CFG_FT_CONS; // stdout
  proc_fd_type[base + 2] = CFG_FT_CONS; // stderr
}

int alloc_fd(int idx) {
  int base;
  int fd;
  base = idx * CFG_NFD;
  fd = 0;
  while (fd < CFG_NFD) {
    if (proc_fd_type[base + fd] == CFG_FT_NONE) {
      return fd;
    }
    fd = fd + 1;
  }
  return -1;
}

// Drop one reference to fd, releasing a pipe end (and freeing the pipe when both
// ends are gone).
void fd_close(int idx, int fd) {
  int base;
  int pp;
  base = idx * CFG_NFD;
  if (proc_fd_type[base + fd] == CFG_FT_PIPE) {
    pp = proc_fd_pipe[base + fd];
    if (proc_fd_pend[base + fd] == 1) {
      pipe_nwrite[pp] = pipe_nwrite[pp] - 1;
    } else {
      pipe_nread[pp] = pipe_nread[pp] - 1;
    }
    if (pipe_nread[pp] == 0 && pipe_nwrite[pp] == 0) {
      pipe_used[pp] = 0;
    }
  }
  proc_fd_type[base + fd] = CFG_FT_NONE;
}

void clear_fds(int idx) {
  int fd;
  fd = 0;
  while (fd < CFG_NFD) {
    if (proc_fd_type[idx * CFG_NFD + fd] != CFG_FT_NONE) {
      fd_close(idx, fd);
    }
    fd = fd + 1;
  }
}

// Copy a parent's fd table to a child (fork), bumping pipe reference counts.
void copy_fds(int dst, int src) {
  int db;
  int sb;
  int fd;
  int t;
  int pp;
  db = dst * CFG_NFD;
  sb = src * CFG_NFD;
  fd = 0;
  while (fd < CFG_NFD) {
    t = proc_fd_type[sb + fd];
    proc_fd_type[db + fd] = t;
    proc_fd_inum[db + fd] = proc_fd_inum[sb + fd];
    proc_fd_off[db + fd] = proc_fd_off[sb + fd];
    proc_fd_pipe[db + fd] = proc_fd_pipe[sb + fd];
    proc_fd_pend[db + fd] = proc_fd_pend[sb + fd];
    if (t == CFG_FT_PIPE) {
      pp = proc_fd_pipe[sb + fd];
      if (proc_fd_pend[sb + fd] == 1) {
        pipe_nwrite[pp] = pipe_nwrite[pp] + 1;
      } else {
        pipe_nread[pp] = pipe_nread[pp] + 1;
      }
    }
    fd = fd + 1;
  }
}
