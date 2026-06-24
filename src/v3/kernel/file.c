// File-descriptor objects and their common operation interface.
//
// Syscalls no longer switch on descriptor types. Each descriptor carries an
// operation table, while object-specific state stays in the file/vnode/pipe
// structures. VFS-backed disk files and pseudo filesystems all enter through
// vnode_file_ops; pipes retain their separate stream operations.
#include "kernel.h"

struct file_ops console_file_ops;
struct file_ops keyboard_file_ops;
struct file_ops vnode_file_ops;
struct file_ops pipe_file_ops;
struct open_file open_file_table[CFG_NFILE];

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
  return tty_read(caller, buf, len);
}

int vnode_read_op(int file_addr, int caller, int buf, int len) {
  struct file *file;
  struct open_file *open;
  int got;
  file = file_addr;
  open = &open_file_table[file->object];
  got = vnode_read(&open->vnode, caller, open->offset, len, buf);
  if (got > 0) open->offset = open->offset + got;
  return got;
}

int vnode_write_op(int file_addr, int caller, int buf, int len) {
  struct file *file;
  struct open_file *open;
  int wrote;
  file = file_addr;
  open = &open_file_table[file->object];
  if (open->vnode.inode.type == CFG_T_DIR) {
    return -CFG_EISDIR;
  }
  wrote = vnode_write(&open->vnode, caller, open->offset, len, buf);
  if (wrote > 0) {
    open->offset = open->offset + wrote;
  }
  return wrote;
}

int file_mmap_read(struct file *file, int offset, int length, int destination) {
  struct open_file *open;
  if (file->type != CFG_FT_FILE || file->object < 0 ||
      file->object >= CFG_NFILE) {
    return -CFG_ENODEV;
  }
  open = &open_file_table[file->object];
  if (open->used == 0 || open->vnode.inode.type != CFG_T_FILE) {
    return -CFG_ENODEV;
  }
  return vnode_read(&open->vnode, current, offset, length, destination);
}

int file_getdents(struct file *file, int caller, int destination, int count) {
  struct open_file *open;
  if (file->type != CFG_FT_FILE || file->object < 0 ||
      file->object >= CFG_NFILE) {
    return -CFG_EBADF;
  }
  open = &open_file_table[file->object];
  if (open->used == 0 || open->vnode.inode.type != CFG_T_DIR) {
    return -CFG_ENOTDIR;
  }
  if (count < sizeof(struct guest_dirent)) {
    return -CFG_EINVAL;
  }
  return vnode_getdents(&open->vnode, caller, &open->offset,
    destination, count);
}

int file_is_tty(struct file *file) {
  struct open_file *open;
  if (file->type == CFG_FT_KBD || file->type == CFG_FT_CONS) return 1;
  if (file->type != CFG_FT_FILE || file->object < 0 ||
      file->object >= CFG_NFILE) return 0;
  open = &open_file_table[file->object];
  return open->used != 0 && vnode_is_tty(&open->vnode);
}

int file_stat(struct file *file, struct guest_stat *st) {
  struct open_file *open;
  if (file->type != CFG_FT_FILE || file->object < 0 ||
      file->object >= CFG_NFILE) {
    return -CFG_EBADF;
  }
  open = &open_file_table[file->object];
  if (open->used == 0) {
    return -CFG_EBADF;
  }
  vnode_stat(&open->vnode, st);
  return 0;
}

int file_lseek(struct file *file, int offset, int whence) {
  struct open_file *open;
  struct guest_stat value;
  int next;
  if (file->type != CFG_FT_FILE || file->object < 0 ||
      file->object >= CFG_NFILE) {
    return -CFG_ESPIPE;
  }
  open = &open_file_table[file->object];
  if (open->used == 0) {
    return -CFG_EBADF;
  }
  if (whence == CFG_SEEK_SET) {
    next = offset;
  } else if (whence == CFG_SEEK_CUR) {
    next = open->offset + offset;
  } else if (whence == CFG_SEEK_END) {
    vnode_stat(&open->vnode, &value);
    next = value.size + offset;
  } else {
    return -CFG_EINVAL;
  }
  if (next < 0) {
    return -CFG_EINVAL;
  }
  open->offset = next;
  return next;
}

void vnode_close_op(int file_addr) {
  struct file *file;
  struct open_file *open;
  file = file_addr;
  open = &open_file_table[file->object];
  open->refs = open->refs - 1;
  if (open->refs == 0) {
    vnode_release(&open->vnode);
    open->used = 0;
  }
}

void vnode_retain_op(int file_addr) {
  struct file *file;
  file = file_addr;
  open_file_table[file->object].refs = open_file_table[file->object].refs + 1;
}

int alloc_open_file(void) {
  int i;
  i = 0;
  while (i < CFG_NFILE) {
    if (open_file_table[i].used == 0) {
      open_file_table[i].used = 1;
      open_file_table[i].refs = 1;
      open_file_table[i].offset = 0;
      return i;
    }
    i = i + 1;
  }
  return -1;
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
  int i;
  i = 0;
  while (i < CFG_NFILE) {
    open_file_table[i].used = 0;
    i = i + 1;
  }

  console_file_ops.read = 0;
  console_file_ops.write = console_write_op;
  console_file_ops.close = 0;
  console_file_ops.retain = 0;

  keyboard_file_ops.read = keyboard_read_op;
  keyboard_file_ops.write = 0;
  keyboard_file_ops.close = 0;
  keyboard_file_ops.retain = 0;

  vnode_file_ops.read = vnode_read_op;
  vnode_file_ops.write = vnode_write_op;
  vnode_file_ops.close = vnode_close_op;
  vnode_file_ops.retain = vnode_retain_op;

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
  file->pipe_end = 0;
  file->object = 0;
  file->fd_flags = 0;
  file->status_flags = 0;
}

void file_set_console(struct file *file) {
  file_reset(file);
  file->ops = &console_file_ops;
  file->type = CFG_FT_CONS;
  file->writable = 1;
  file->status_flags = 1;
}

void file_set_keyboard(struct file *file) {
  file_reset(file);
  file->ops = &keyboard_file_ops;
  file->type = CFG_FT_KBD;
  file->readable = 1;
  file->status_flags = 0;
}

int file_set_vnode(struct file *file, int inum) {
  struct vnode node;
  disk_vnode_init(&node, inum);
  return file_set_node(file, &node);
}

int file_set_node(struct file *file, struct vnode *node) {
  int open;
  open = alloc_open_file();
  if (open < 0) {
    return -1;
  }
  file_reset(file);
  file->ops = &vnode_file_ops;
  file->type = CFG_FT_FILE;
  file->readable = 1;
  file->writable = 0;
  file->object = open;
  memcpy(&open_file_table[open].vnode, node, sizeof(struct vnode));
  return 0;
}

void file_set_pipe(struct file *file, int pipe, int end) {
  file_reset(file);
  file->ops = &pipe_file_ops;
  file->type = CFG_FT_PIPE;
  file->object = pipe;
  file->pipe_end = end;
  if (end == 0) {
    file->readable = 1;
    file->status_flags = 0;
  } else {
    file->writable = 1;
    file->status_flags = 1;
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
  struct vnode console;
  fd = 0;
  while (fd < CFG_NFD) {
    file_reset(&proc_table[idx].files[fd]);
    fd = fd + 1;
  }
  if (vfs_lookup("/dev/tty", 1, idx, &console) < 0) {
    panic("missing /dev/tty");
  }
  file_set_node(&proc_table[idx].files[0], &console);
  proc_table[idx].files[0].readable = 1;
  proc_table[idx].files[0].writable = 0;
  file_set_node(&proc_table[idx].files[1], &console);
  proc_table[idx].files[1].readable = 0;
  proc_table[idx].files[1].writable = 1;
  file_set_node(&proc_table[idx].files[2], &console);
  proc_table[idx].files[2].readable = 0;
  proc_table[idx].files[2].writable = 1;
}

int alloc_fd(int idx) {
  return alloc_fd_from(idx, 0);
}

int alloc_fd_from(int idx, int minimum) {
  int fd;
  fd = minimum;
  if (fd < 0) {
    fd = 0;
  }
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
  dst->pipe_end = src->pipe_end;
  dst->object = src->object;
  dst->fd_flags = src->fd_flags;
  dst->status_flags = src->status_flags;
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

void close_exec_fds(int idx) {
  int fd;
  fd = 0;
  while (fd < CFG_NFD) {
    if ((proc_table[idx].files[fd].fd_flags & CFG_FD_CLOEXEC) != 0) {
      fd_close(idx, fd);
    }
    fd = fd + 1;
  }
}
