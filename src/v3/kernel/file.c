// File-descriptor objects and their common operation interface.
//
// Syscalls no longer switch on descriptor types. Each descriptor carries an
// operation table, while object-specific state stays in the file/vnode/pipe
// structures. This is the extension point for future VFS, TTY, and device files.
#include "kernel.h"

struct file_ops console_file_ops;
struct file_ops keyboard_file_ops;
struct file_ops vnode_file_ops;
struct file_ops pipe_file_ops;

int console_write_op(int file_addr, int caller, int buf, int len) {
  char *p;
  int i;
  p = buf;
  i = 0;
  while (i < len) {
    serial_putc(p[i]);
    i = i + 1;
  }
  return len;
}

int keyboard_read_op(int file_addr, int caller, int buf, int len) {
  int ch;
  if (len == 0) {
    return 0;
  }
  ch = kbd_getc();
  if (ch == 0) {
    if (kbd_eof()) {
      return 0;
    }
    g_noret = 1;
    proc_table[caller].ctx.pc =
      proc_table[caller].ctx.pc - CFG_SYSCALL_INSTR_SIZE;
    sleep(caller, &kbd_chan);
    return 0;
  }
  write8_at(buf, ch);
  return 1;
}

int vnode_read_op(int file_addr, int caller, int buf, int len) {
  struct file *file;
  int got;
  file = file_addr;
  got = vnode_read(&file->vnode, file->offset, len, buf);
  file->offset = file->offset + got;
  return got;
}

int pipe_read_op(int file_addr, int caller, int buf, int len) {
  struct file *file;
  struct pipe *pipe;
  int n;
  file = file_addr;
  pipe = &pipe_table[file->object];
  if (file->pipe_end != 0) {
    return -CFG_EBADF;
  }
  if (pipe->count > 0) {
    n = pipe_read_bytes(file->object, buf, len);
    wakeup(pipe);
    return n;
  }
  if (pipe->nwrite == 0) {
    return 0;
  }
  g_noret = 1;
  proc_table[caller].ctx.pc =
    proc_table[caller].ctx.pc - CFG_SYSCALL_INSTR_SIZE;
  sleep(caller, pipe);
  return 0;
}

int pipe_write_op(int file_addr, int caller, int buf, int len) {
  struct file *file;
  struct pipe *pipe;
  int n;
  file = file_addr;
  pipe = &pipe_table[file->object];
  if (file->pipe_end != 1) {
    return -CFG_EBADF;
  }
  if (pipe->nread == 0) {
    return -CFG_EPIPE;
  }
  if (pipe->count == CFG_PIPESZ) {
    g_noret = 1;
    proc_table[caller].ctx.pc =
      proc_table[caller].ctx.pc - CFG_SYSCALL_INSTR_SIZE;
    sleep(caller, pipe);
    return 0;
  }
  n = pipe_write_bytes(file->object, buf, len);
  wakeup(pipe);
  return n;
}

void pipe_close_op(int file_addr) {
  struct file *file;
  struct pipe *pipe;
  file = file_addr;
  pipe = &pipe_table[file->object];
  if (file->pipe_end == 1) {
    pipe->nwrite = pipe->nwrite - 1;
  } else {
    pipe->nread = pipe->nread - 1;
  }
  wakeup(pipe);
  if (pipe->nread == 0 && pipe->nwrite == 0) {
    pipe->used = 0;
  }
}

void pipe_retain_op(int file_addr) {
  struct file *file;
  struct pipe *pipe;
  file = file_addr;
  pipe = &pipe_table[file->object];
  if (file->pipe_end == 1) {
    pipe->nwrite = pipe->nwrite + 1;
  } else {
    pipe->nread = pipe->nread + 1;
  }
}

void file_init(void) {
  console_file_ops.read = 0;
  console_file_ops.write = console_write_op;
  console_file_ops.close = 0;
  console_file_ops.retain = 0;

  keyboard_file_ops.read = keyboard_read_op;
  keyboard_file_ops.write = 0;
  keyboard_file_ops.close = 0;
  keyboard_file_ops.retain = 0;

  vnode_file_ops.read = vnode_read_op;
  vnode_file_ops.write = 0;
  vnode_file_ops.close = 0;
  vnode_file_ops.retain = 0;

  pipe_file_ops.read = pipe_read_op;
  pipe_file_ops.write = pipe_write_op;
  pipe_file_ops.close = pipe_close_op;
  pipe_file_ops.retain = pipe_retain_op;
}

void file_reset(struct file *file) {
  file->ops = 0;
  file->type = CFG_FT_NONE;
  file->readable = 0;
  file->writable = 0;
  file->offset = 0;
  file->pipe_end = 0;
  file->vnode.inode.inum = 0;
  file->vnode.inode.type = 0;
  file->vnode.inode.size = 0;
  file->object = 0;
}

void file_set_console(struct file *file) {
  file_reset(file);
  file->ops = &console_file_ops;
  file->type = CFG_FT_CONS;
  file->writable = 1;
}

void file_set_keyboard(struct file *file) {
  file_reset(file);
  file->ops = &keyboard_file_ops;
  file->type = CFG_FT_KBD;
  file->readable = 1;
}

void file_set_vnode(struct file *file, int inum) {
  file_reset(file);
  file->ops = &vnode_file_ops;
  file->type = CFG_FT_FILE;
  file->readable = 1;
  vnode_init(&file->vnode, inum);
}

void file_set_pipe(struct file *file, int pipe, int end) {
  file_reset(file);
  file->ops = &pipe_file_ops;
  file->type = CFG_FT_PIPE;
  file->object = pipe;
  file->pipe_end = end;
  if (end == 0) {
    file->readable = 1;
  } else {
    file->writable = 1;
  }
}

int file_read(struct file *file, int caller, int buf, int len) {
  if (file->ops == 0 || file->readable == 0 || file->ops->read == 0) {
    return -CFG_EBADF;
  }
  return file->ops->read(file, caller, buf, len);
}

int file_write(struct file *file, int caller, int buf, int len) {
  if (file->ops == 0 || file->writable == 0 || file->ops->write == 0) {
    return -CFG_EBADF;
  }
  return file->ops->write(file, caller, buf, len);
}

void file_close(struct file *file) {
  if (file->ops != 0 && file->ops->close != 0) {
    file->ops->close(file);
  }
  file_reset(file);
}

void file_retain(struct file *file) {
  if (file->ops != 0 && file->ops->retain != 0) {
    file->ops->retain(file);
  }
}

void init_fds(int idx) {
  int fd;
  fd = 0;
  while (fd < CFG_NFD) {
    file_reset(&proc_table[idx].files[fd]);
    fd = fd + 1;
  }
  file_set_keyboard(&proc_table[idx].files[0]);
  file_set_console(&proc_table[idx].files[1]);
  file_set_console(&proc_table[idx].files[2]);
}

int alloc_fd(int idx) {
  int fd;
  fd = 0;
  while (fd < CFG_NFD) {
    if (proc_table[idx].files[fd].type == CFG_FT_NONE) {
      return fd;
    }
    fd = fd + 1;
  }
  return -1;
}

void fd_close(int idx, int fd) {
  file_close(&proc_table[idx].files[fd]);
}

void clear_fds(int idx) {
  int fd;
  fd = 0;
  while (fd < CFG_NFD) {
    if (proc_table[idx].files[fd].type != CFG_FT_NONE) {
      fd_close(idx, fd);
    }
    fd = fd + 1;
  }
}

void copy_file(struct file *dst, struct file *src) {
  dst->ops = src->ops;
  dst->type = src->type;
  dst->readable = src->readable;
  dst->writable = src->writable;
  dst->offset = src->offset;
  dst->pipe_end = src->pipe_end;
  dst->vnode.inode.inum = src->vnode.inode.inum;
  dst->vnode.inode.type = src->vnode.inode.type;
  dst->vnode.inode.size = src->vnode.inode.size;
  dst->object = src->object;
  file_retain(dst);
}

void copy_fds(int dst, int src) {
  int fd;
  fd = 0;
  while (fd < CFG_NFD) {
    copy_file(&proc_table[dst].files[fd], &proc_table[src].files[fd]);
    fd = fd + 1;
  }
}
