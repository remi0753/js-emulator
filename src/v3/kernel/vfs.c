// Virtual filesystem and memory-backed pseudo filesystems.
//
// The mount table routes absolute paths to the disk filesystem, devfs, procfs,
// or tmpfs. Once resolved, every object is a vnode and open descriptors use the
// same vnode file operations regardless of the backing filesystem.
#include "kernel.h"

struct vnode_ops disk_vnode_ops;
struct vnode_ops dev_vnode_ops;
struct vnode_ops proc_vnode_ops;
struct vnode_ops tmp_vnode_ops;
struct mount mount_table[CFG_NMOUNT];

struct tmp_node {
  int used;
  int linked;
  int type;
  int mode;
  int uid;
  int gid;
  int size;
  char name[16];
  char data[CFG_TMP_FILE_SIZE];
};

struct tmp_node tmp_nodes[CFG_NTMPNODE];
char proc_text[64];

void vnode_clear(struct vnode *node) {
  memset(node, 0, sizeof(struct vnode));
}

void vnode_fill(
  struct vnode *node, struct vnode_ops *ops, int fs_type, int object,
  int type, int mode, int size
) {
  vnode_clear(node);
  node->ops = ops;
  node->fs_type = fs_type;
  node->object = object;
  node->inode.inum = object;
  node->inode.type = type;
  node->inode.nlink = 1;
  node->inode.mode = mode;
  node->inode.uid = 0;
  node->inode.gid = 0;
  node->inode.size = size;
}

void mount_set(int slot, int fs_type, char *path) {
  mount_table[slot].used = 1;
  mount_table[slot].fs_type = fs_type;
  mount_table[slot].root_inum = 0;
  memset(mount_table[slot].path, 0, 8);
  memcpy(mount_table[slot].path, path, strlen(path));
}

char *vfs_mounted_path(int inum) {
  int i;
  i = 1;
  while (i < CFG_NMOUNT) {
    if (mount_table[i].used != 0 &&
        mount_table[i].root_inum == inum) {
      return mount_table[i].path;
    }
    i = i + 1;
  }
  return 0;
}

int mount_matches(char *path, char *mount_path) {
  int n;
  int i;
  n = strlen(mount_path);
  i = 0;
  while (i < n) {
    if (path[i] != mount_path[i]) return 0;
    i = i + 1;
  }
  return path[n] == 0 || path[n] == '/';
}

int vfs_mount_for(char *path) {
  int i;
  int best;
  int best_len;
  int n;
  best = 0;
  best_len = 0;
  i = 0;
  while (i < CFG_NMOUNT) {
    if (mount_table[i].used != 0 &&
        mount_matches(path, mount_table[i].path)) {
      n = strlen(mount_table[i].path);
      if (n >= best_len) {
        best = i;
        best_len = n;
      }
    }
    i = i + 1;
  }
  return best;
}

char *mount_relative(char *path, char *mount_path) {
  int n;
  n = strlen(mount_path);
  if (path[n] == '/') return path + n + 1;
  return path + n;
}

int disk_read_op(int node_addr, int caller, int off, int buf, int len) {
  struct vnode *node;
  node = node_addr;
  return disk_vnode_read(node, off, len, buf);
}

int disk_write_op(int node_addr, int caller, int off, int buf, int len) {
  struct vnode *node;
  node = node_addr;
  return disk_vnode_write(node, off, len, buf);
}

int emit_dirent(
  int caller, int destination, int ino, int offset, int type, char *name
) {
  struct guest_dirent entry;
  int i;
  entry.ino = ino;
  entry.offset = offset;
  entry.reclen = sizeof(struct guest_dirent);
  entry.type = type;
  i = 0;
  while (i < 16) {
    if (i < strlen(name)) entry.name[i] = name[i];
    else entry.name[i] = 0;
    i = i + 1;
  }
  return copyout(caller, destination, &entry, sizeof(struct guest_dirent));
}

int disk_getdents_op(
  int node_addr, int caller, int offset_addr, int destination, int count
) {
  struct vnode *node;
  int *offset;
  char raw[16];
  char name[16];
  int written;
  int inum;
  int i;
  node = node_addr;
  offset = offset_addr;
  if (node->inode.type != CFG_T_DIR) return -CFG_ENOTDIR;
  if (count < sizeof(struct guest_dirent)) return -CFG_EINVAL;
  written = 0;
  while (written + sizeof(struct guest_dirent) <= count &&
      *offset + 16 <= inode_size(node->inode.inum)) {
    readi(node->inode.inum, *offset, 16, raw);
    *offset = *offset + 16;
    inum = read16_at(raw);
    if (inum != 0) {
      i = 0;
      while (i < 16) {
        if (i < CFG_DIRSIZ) name[i] = raw[i + 2];
        else name[i] = 0;
        i = i + 1;
      }
      if (emit_dirent(caller, destination + written, inum, *offset,
          inode_type(inum), name) < 0) return -CFG_EFAULT;
      written = written + sizeof(struct guest_dirent);
    }
  }
  return written;
}

void disk_stat_op(int node_addr, int stat_addr) {
  struct vnode *node;
  struct guest_stat *st;
  node = node_addr;
  st = stat_addr;
  inode_stat(node->inode.inum, st);
}

int disk_truncate_op(int node_addr) {
  struct vnode *node;
  node = node_addr;
  if ((fs_mount_flags & 1) != 0) return -CFG_EROFS;
  itrunc(node->inode.inum);
  disk_vnode_init(node, node->inode.inum);
  return 0;
}

void disk_release_op(int node_addr) {
  struct vnode *node;
  node = node_addr;
  if (inode_nlink(node->inode.inum) == 0 &&
      inode_open_count(node->inode.inum) <= 1) {
    ifree(node->inode.inum);
  }
}

// devfs is now driven by the char-device registry (device.c): a /dev name
// resolves to the major number of whichever driver claimed it, and reads/writes
// dispatch through that driver's operation table.
int dev_lookup(char *relative, struct vnode *node) {
  int major;
  if (relative[0] == 0) {
    vnode_fill(node, &dev_vnode_ops, CFG_FS_DEV, 0,
      CFG_T_DIR, CFG_S_IFDIR | 493, 0);
    node->inode.nlink = 2;
    return 0;
  }
  major = chardev_lookup(relative);
  if (major < 0) return -CFG_ENOENT;
  vnode_fill(node, &dev_vnode_ops, CFG_FS_DEV, major,
    CFG_T_FILE, chardev_table[major].mode, 0);
  return 0;
}

int dev_read_op(int node_addr, int caller, int off, int buf, int len) {
  struct vnode *node;
  node = node_addr;
  if (node->object == 0) return -CFG_EISDIR;
  return chardev_read(node->object, node_addr, caller, off, buf, len);
}

int dev_write_op(int node_addr, int caller, int off, int buf, int len) {
  struct vnode *node;
  node = node_addr;
  if (node->object == 0) return -CFG_EISDIR;
  return chardev_write(node->object, node_addr, caller, off, buf, len);
}

int dev_getdents_op(
  int node_addr, int caller, int offset_addr, int destination, int count
) {
  int *offset;
  int written;
  int major;
  offset = offset_addr;
  if (count < sizeof(struct guest_dirent)) return -CFG_EINVAL;
  written = 0;
  while (*offset < CFG_NCHARDEV &&
      written + sizeof(struct guest_dirent) <= count) {
    major = *offset;
    *offset = *offset + 1;
    if (major >= 1 && chardev_table[major].used != 0) {
      if (emit_dirent(caller, destination + written, major, *offset,
          CFG_T_FILE, chardev_table[major].name) < 0) return -CFG_EFAULT;
      written = written + sizeof(struct guest_dirent);
    }
  }
  return written;
}

void generic_stat_op(int node_addr, int stat_addr) {
  struct vnode *node;
  struct guest_stat *st;
  node = node_addr;
  st = stat_addr;
  if (node->fs_type == CFG_FS_TMP && node->object > 0) {
    tmp_vnode_init(node, node->object);
  }
  memset(st, 0, sizeof(struct guest_stat));
  st->dev = node->fs_type;
  st->ino = node->inode.inum;
  st->mode = node->inode.mode;
  st->nlink = node->inode.nlink;
  st->uid = node->inode.uid;
  st->gid = node->inode.gid;
  st->rdev = 0;
  if (node->fs_type == CFG_FS_DEV) st->rdev = chardev_rdev(node->object);
  st->size = node->inode.size;
  st->blksize = 512;
  st->blocks = (node->inode.size + 511) / 512;
}

int parse_pid(char *text, int *used) {
  int value;
  int i;
  int c;
  value = 0;
  i = 0;
  c = text[i];
  if (c < '0' || c > '9') return -1;
  while (c >= '0' && c <= '9') {
    value = value * 10 + c - '0';
    i = i + 1;
    c = text[i];
  }
  *used = i;
  return value;
}

int proc_lookup(char *relative, int follow, int caller, struct vnode *node) {
  int pid;
  int used;
  char *rest;
  if (relative[0] == 0) {
    vnode_fill(node, &proc_vnode_ops, CFG_FS_PROC, 0,
      CFG_T_DIR, CFG_S_IFDIR | 365, 0);
    node->inode.nlink = 2;
    return 0;
  }
  if (strcmp(relative, "self") == 0 && follow == 0) {
    vnode_fill(node, &proc_vnode_ops, CFG_FS_PROC, 1,
      CFG_T_SYMLINK, CFG_S_IFLNK | 511, 1);
    return 0;
  }
  if (relative[0] == 's' && relative[1] == 'e' &&
      relative[2] == 'l' && relative[3] == 'f' &&
      (relative[4] == 0 || relative[4] == '/')) {
    pid = caller;
    rest = relative + 4;
  } else {
    pid = parse_pid(relative, &used);
    if (pid < 0) return -CFG_ENOENT;
    rest = relative + used;
  }
  if (pid < 0 || pid >= nproc || proc_table[pid].state == CFG_ST_UNUSED) {
    return -CFG_ENOENT;
  }
  if (rest[0] == 0) {
    vnode_fill(node, &proc_vnode_ops, CFG_FS_PROC, 100 + pid,
      CFG_T_DIR, CFG_S_IFDIR | 365, 0);
    node->inode.nlink = 2;
    return 0;
  }
  if (rest[0] == '/' && strcmp(rest + 1, "status") == 0) {
    vnode_fill(node, &proc_vnode_ops, CFG_FS_PROC, 200 + pid,
      CFG_T_FILE, CFG_S_IFREG | 292, 32);
    return 0;
  }
  return -CFG_ENOENT;
}

int append_text(char *dst, int at, char *text) {
  int i;
  i = 0;
  while (text[i] != 0) {
    dst[at] = text[i];
    at = at + 1;
    i = i + 1;
  }
  return at;
}

int append_number(char *dst, int at, int value) {
  char digits[12];
  int n;
  int i;
  if (value == 0) {
    dst[at] = '0';
    return at + 1;
  }
  n = 0;
  while (value > 0) {
    digits[n] = '0' + value % 10;
    value = value / 10;
    n = n + 1;
  }
  i = n - 1;
  while (i >= 0) {
    dst[at] = digits[i];
    at = at + 1;
    i = i - 1;
  }
  return at;
}

int proc_status_text(int pid) {
  int n;
  char state;
  n = append_text(proc_text, 0, "Pid:\t");
  n = append_number(proc_text, n, pid);
  n = append_text(proc_text, n, "\nState:\t");
  if (proc_table[pid].state == CFG_ST_RUNNABLE) state = 'R';
  else if (proc_table[pid].state == CFG_ST_SLEEPING) state = 'S';
  else if (proc_table[pid].state == CFG_ST_STOPPED) state = 'T';
  else if (proc_table[pid].state == CFG_ST_ZOMBIE) state = 'Z';
  else state = '?';
  proc_text[n] = state;
  n = n + 1;
  n = append_text(proc_text, n, "\n");
  return n;
}

int proc_read_op(int node_addr, int caller, int off, int buf, int len) {
  struct vnode *node;
  int total;
  int take;
  node = node_addr;
  if (node->object < 200) return -CFG_EISDIR;
  total = proc_status_text(node->object - 200);
  if (off >= total) return 0;
  take = total - off;
  if (take > len) take = len;
  memcpy(buf, proc_text + off, take);
  return take;
}

int proc_getdents_op(
  int node_addr, int caller, int offset_addr, int destination, int count
) {
  struct vnode *node;
  int *offset;
  int written;
  int logical;
  int pid;
  char name[16];
  node = node_addr;
  offset = offset_addr;
  if (node->inode.type != CFG_T_DIR) return -CFG_ENOTDIR;
  if (count < sizeof(struct guest_dirent)) return -CFG_EINVAL;
  written = 0;
  if (node->object >= 100) {
    if (*offset == 0) {
      if (emit_dirent(caller, destination, node->object + 100, 1,
          CFG_T_FILE, "status") < 0) return -CFG_EFAULT;
      *offset = 1;
      return sizeof(struct guest_dirent);
    }
    return 0;
  }
  logical = *offset;
  if (logical == 0 &&
      written + sizeof(struct guest_dirent) <= count) {
    if (emit_dirent(caller, destination, 1, 1,
        CFG_T_SYMLINK, "self") < 0) return -CFG_EFAULT;
    logical = 1;
    written = written + sizeof(struct guest_dirent);
  }
  pid = logical - 1;
  while (pid < nproc &&
      written + sizeof(struct guest_dirent) <= count) {
    if (proc_table[pid].state != CFG_ST_UNUSED) {
      memset(name, 0, 16);
      append_number(name, 0, pid);
      if (emit_dirent(caller, destination + written, 100 + pid,
          pid + 2, CFG_T_DIR, name) < 0) return -CFG_EFAULT;
      written = written + sizeof(struct guest_dirent);
    }
    pid = pid + 1;
  }
  *offset = pid + 1;
  return written;
}

int tmp_name(char *relative) {
  int i;
  if (relative[0] == 0) return 0;
  i = 0;
  while (relative[i] != 0) {
    if (relative[i] == '/' || i >= 15) return -1;
    i = i + 1;
  }
  return i;
}

int tmp_find(char *relative) {
  int i;
  i = 1;
  while (i < CFG_NTMPNODE) {
    if (tmp_nodes[i].used != 0 && tmp_nodes[i].linked != 0 &&
        strcmp(tmp_nodes[i].name, relative) == 0) return i;
    i = i + 1;
  }
  return 0;
}

void tmp_vnode_init(struct vnode *node, int index) {
  if (index == 0) {
    vnode_fill(node, &tmp_vnode_ops, CFG_FS_TMP, 0,
      CFG_T_DIR, CFG_S_IFDIR | 511, 0);
    node->inode.nlink = 2;
    return;
  }
  vnode_fill(node, &tmp_vnode_ops, CFG_FS_TMP, index,
    tmp_nodes[index].type, tmp_nodes[index].mode, tmp_nodes[index].size);
  node->inode.nlink = tmp_nodes[index].linked;
  node->inode.uid = tmp_nodes[index].uid;
  node->inode.gid = tmp_nodes[index].gid;
}

int tmp_lookup(char *relative, struct vnode *node) {
  int index;
  if (relative[0] == 0) {
    tmp_vnode_init(node, 0);
    return 0;
  }
  if (tmp_name(relative) < 0) return -CFG_ENOENT;
  index = tmp_find(relative);
  if (index == 0) return -CFG_ENOENT;
  tmp_vnode_init(node, index);
  return 0;
}

int tmp_create(char *relative, int type, int mode, struct vnode *node) {
  int i;
  if (type != CFG_T_FILE) return -CFG_ENOTDIR;
  if (tmp_name(relative) <= 0) return -CFG_EINVAL;
  i = tmp_find(relative);
  if (i != 0) {
    tmp_vnode_init(node, i);
    return 0;
  }
  i = 1;
  while (i < CFG_NTMPNODE && tmp_nodes[i].used != 0) i = i + 1;
  if (i == CFG_NTMPNODE) return -CFG_ENOSPC;
  memset(&tmp_nodes[i], 0, sizeof(struct tmp_node));
  tmp_nodes[i].used = 1;
  tmp_nodes[i].linked = 1;
  tmp_nodes[i].type = CFG_T_FILE;
  tmp_nodes[i].mode = CFG_S_IFREG | (mode & 4095);
  memcpy(tmp_nodes[i].name, relative, strlen(relative));
  tmp_vnode_init(node, i);
  return 0;
}

int tmp_read_op(int node_addr, int caller, int off, int buf, int len) {
  struct vnode *node;
  struct tmp_node *tmp;
  int take;
  node = node_addr;
  if (node->object == 0) return -CFG_EISDIR;
  tmp = &tmp_nodes[node->object];
  if (off >= tmp->size) return 0;
  take = tmp->size - off;
  if (take > len) take = len;
  memcpy(buf, tmp->data + off, take);
  return take;
}

int tmp_write_op(int node_addr, int caller, int off, int buf, int len) {
  struct vnode *node;
  struct tmp_node *tmp;
  int take;
  node = node_addr;
  if (node->object == 0) return -CFG_EISDIR;
  tmp = &tmp_nodes[node->object];
  if (off >= CFG_TMP_FILE_SIZE) return -CFG_ENOSPC;
  take = len;
  if (take > CFG_TMP_FILE_SIZE - off) take = CFG_TMP_FILE_SIZE - off;
  memcpy(tmp->data + off, buf, take);
  if (off + take > tmp->size) tmp->size = off + take;
  node->inode.size = tmp->size;
  return take;
}

int tmp_getdents_op(
  int node_addr, int caller, int offset_addr, int destination, int count
) {
  int *offset;
  int written;
  int i;
  offset = offset_addr;
  if (count < sizeof(struct guest_dirent)) return -CFG_EINVAL;
  written = 0;
  i = *offset + 1;
  while (i < CFG_NTMPNODE &&
      written + sizeof(struct guest_dirent) <= count) {
    if (tmp_nodes[i].used != 0 && tmp_nodes[i].linked != 0) {
      if (emit_dirent(caller, destination + written, i, i,
          tmp_nodes[i].type, tmp_nodes[i].name) < 0) return -CFG_EFAULT;
      written = written + sizeof(struct guest_dirent);
    }
    i = i + 1;
  }
  *offset = i - 1;
  return written;
}

int tmp_truncate_op(int node_addr) {
  struct vnode *node;
  node = node_addr;
  if (node->object == 0) return -CFG_EISDIR;
  tmp_nodes[node->object].size = 0;
  node->inode.size = 0;
  return 0;
}

int tmp_open_count(int index) {
  int i;
  int count;
  i = 0;
  count = 0;
  while (i < CFG_NFILE) {
    if (open_file_table[i].used != 0 &&
        open_file_table[i].vnode.fs_type == CFG_FS_TMP &&
        open_file_table[i].vnode.object == index) count = count + 1;
    i = i + 1;
  }
  return count;
}

void tmp_release_op(int node_addr) {
  struct vnode *node;
  node = node_addr;
  if (node->object > 0 && tmp_nodes[node->object].linked == 0 &&
      tmp_open_count(node->object) <= 1) {
    tmp_nodes[node->object].used = 0;
  }
}

int vfs_lookup_depth(
  int path, int follow, int caller, struct vnode *node, int depth
) {
  int mount_index;
  int inum;
  char *relative;
  if (depth > 8) return -CFG_ELOOP;
  mount_index = vfs_mount_for(path);
  relative = mount_relative(path, mount_table[mount_index].path);
  if (mount_table[mount_index].fs_type == CFG_FS_DEV) {
    return dev_lookup(relative, node);
  }
  if (mount_table[mount_index].fs_type == CFG_FS_PROC) {
    return proc_lookup(relative, follow, caller, node);
  }
  if (mount_table[mount_index].fs_type == CFG_FS_TMP) {
    return tmp_lookup(relative, node);
  }
  if (mount_table[mount_index].fs_type == CFG_FS_SYS) {
    return sys_lookup(relative, node);
  }
  inum = namei_access(path, follow, proc_table[caller].uid,
    proc_table[caller].gid);
  if (inum == 0 && fs_redirect_valid != 0) {
    return vfs_lookup_depth(fs_redirect_path, follow, caller, node, depth + 1);
  }
  if (inum == 0) return 0 - fs_lookup_error;
  disk_vnode_init(node, inum);
  return 0;
}

int vfs_lookup(int path, int follow, int caller, struct vnode *node) {
  return vfs_lookup_depth(path, follow, caller, node, 0);
}

int vfs_create(int path, int type, int mode, int caller, struct vnode *node) {
  int mount_index;
  int inum;
  char *relative;
  mount_index = vfs_mount_for(path);
  relative = mount_relative(path, mount_table[mount_index].path);
  if (mount_table[mount_index].fs_type == CFG_FS_TMP) {
    return tmp_create(relative, type, mode, node);
  }
  if (mount_table[mount_index].fs_type != CFG_FS_DISK) return -CFG_EROFS;
  inum = create_inode(path, type, mode);
  if (inum < 0) return inum;
  disk_vnode_init(node, inum);
  return 0;
}

int vfs_unlink(int path, int remove_dir, int caller) {
  int mount_index;
  int index;
  char *relative;
  mount_index = vfs_mount_for(path);
  relative = mount_relative(path, mount_table[mount_index].path);
  if (mount_table[mount_index].fs_type == CFG_FS_TMP) {
    if (remove_dir != 0) return -CFG_ENOTDIR;
    index = tmp_find(relative);
    if (index == 0) return -CFG_ENOENT;
    tmp_nodes[index].linked = 0;
    if (tmp_open_count(index) == 0) tmp_nodes[index].used = 0;
    return 0;
  }
  if (mount_table[mount_index].fs_type != CFG_FS_DISK) return -CFG_EROFS;
  return unlink_path(path, remove_dir);
}

int vfs_link(int oldpath, int newpath) {
  int old_mount;
  int new_mount;
  old_mount = vfs_mount_for(oldpath);
  new_mount = vfs_mount_for(newpath);
  if (mount_table[old_mount].fs_type != CFG_FS_DISK ||
      mount_table[new_mount].fs_type != CFG_FS_DISK) return -CFG_EROFS;
  return link_path(oldpath, newpath);
}

int vfs_rename(int oldpath, int newpath) {
  int old_mount;
  int new_mount;
  old_mount = vfs_mount_for(oldpath);
  new_mount = vfs_mount_for(newpath);
  if (mount_table[old_mount].fs_type != CFG_FS_DISK ||
      mount_table[new_mount].fs_type != CFG_FS_DISK) return -CFG_EROFS;
  return rename_path(oldpath, newpath);
}

int vfs_symlink(int target, int linkpath) {
  int mount_index;
  mount_index = vfs_mount_for(linkpath);
  if (mount_table[mount_index].fs_type != CFG_FS_DISK) return -CFG_EROFS;
  return symlink_path(target, linkpath);
}

int vfs_chmod(int path, int mode, int caller) {
  struct vnode node;
  int result;
  int index;
  result = vfs_lookup(path, 1, caller, &node);
  if (result < 0) return result;
  if (node.fs_type == CFG_FS_DISK) return chmod_path(path, mode);
  if (node.fs_type != CFG_FS_TMP || node.object == 0) return -CFG_EROFS;
  index = node.object;
  tmp_nodes[index].mode =
    (tmp_nodes[index].mode & CFG_S_IFMT) | (mode & 4095);
  return 0;
}

int vfs_chown(int path, int uid, int gid, int caller) {
  struct vnode node;
  int result;
  int index;
  result = vfs_lookup(path, 1, caller, &node);
  if (result < 0) return result;
  if (node.fs_type == CFG_FS_DISK) return chown_path(path, uid, gid);
  if (node.fs_type != CFG_FS_TMP || node.object == 0) return -CFG_EROFS;
  index = node.object;
  if (uid >= 0) tmp_nodes[index].uid = uid;
  if (gid >= 0) tmp_nodes[index].gid = gid;
  return 0;
}

int vfs_readlink(int path, int caller, int dst, int size) {
  struct vnode node;
  int result;
  int n;
  char value[16];
  result = vfs_lookup(path, 0, caller, &node);
  if (result < 0) return result;
  if (node.fs_type == CFG_FS_DISK) return readlink_path(path, dst, size);
  if (node.fs_type == CFG_FS_PROC && node.object == 1) {
    memset(value, 0, 16);
    n = append_number(value, 0, caller);
    if (n > size) n = size;
    memcpy(dst, value, n);
    return n;
  }
  return -CFG_EINVAL;
}

int vnode_read(struct vnode *node, int caller, int off, int n, int dst) {
  if (node->ops == 0 || node->ops->read == 0) return -CFG_EBADF;
  return node->ops->read(node, caller, off, dst, n);
}

int vnode_write(struct vnode *node, int caller, int off, int n, int src) {
  if (node->ops == 0 || node->ops->write == 0) return -CFG_EBADF;
  return node->ops->write(node, caller, off, src, n);
}

int vnode_getdents(
  struct vnode *node, int caller, int off, int destination, int count
) {
  if (node->ops == 0 || node->ops->getdents == 0) return -CFG_ENOTDIR;
  return node->ops->getdents(node, caller, off, destination, count);
}

void vnode_stat(struct vnode *node, struct guest_stat *st) {
  node->ops->stat(node, st);
}

int vnode_truncate(struct vnode *node) {
  if (node->ops->truncate == 0) return -CFG_EROFS;
  return node->ops->truncate(node);
}

void vnode_release(struct vnode *node) {
  if (node->ops != 0 && node->ops->release != 0) node->ops->release(node);
}

int vnode_access(struct vnode *node, int uid, int gid, int mask) {
  int mode;
  int bits;
  if (node->fs_type == CFG_FS_DISK) {
    return inode_access(node->inode.inum, uid, gid, mask);
  }
  mode = node->inode.mode;
  if (uid == 0) {
    if ((mask & 1) != 0 && (mode & 73) == 0) return 0;
    return 1;
  }
  if (uid == node->inode.uid) bits = (mode >> 6) & 7;
  else if (gid == node->inode.gid) bits = (mode >> 3) & 7;
  else bits = mode & 7;
  return (bits & mask) == mask;
}

int vnode_is_tty(struct vnode *node) {
  return node->fs_type == CFG_FS_DEV &&
    (node->object == 1 || node->object == 4);
}

void vfs_init(void) {
  int i;
  i = 0;
  while (i < CFG_NMOUNT) {
    mount_table[i].used = 0;
    i = i + 1;
  }
  mount_set(0, CFG_FS_DISK, "/");
  mount_set(1, CFG_FS_DEV, "/dev");
  mount_set(2, CFG_FS_PROC, "/proc");
  mount_set(3, CFG_FS_TMP, "/tmp");
  mount_set(4, CFG_FS_SYS, "/sys");
  mount_table[1].root_inum = namei_nofollow("/dev");
  mount_table[2].root_inum = namei_nofollow("/proc");
  mount_table[3].root_inum = namei_nofollow("/tmp");
  mount_table[4].root_inum = namei_nofollow("/sys");

  disk_vnode_ops.read = disk_read_op;
  disk_vnode_ops.write = disk_write_op;
  disk_vnode_ops.getdents = disk_getdents_op;
  disk_vnode_ops.stat = disk_stat_op;
  disk_vnode_ops.truncate = disk_truncate_op;
  disk_vnode_ops.release = disk_release_op;

  dev_vnode_ops.read = dev_read_op;
  dev_vnode_ops.write = dev_write_op;
  dev_vnode_ops.getdents = dev_getdents_op;
  dev_vnode_ops.stat = generic_stat_op;
  dev_vnode_ops.truncate = 0;
  dev_vnode_ops.release = 0;

  proc_vnode_ops.read = proc_read_op;
  proc_vnode_ops.write = 0;
  proc_vnode_ops.getdents = proc_getdents_op;
  proc_vnode_ops.stat = generic_stat_op;
  proc_vnode_ops.truncate = 0;
  proc_vnode_ops.release = 0;

  tmp_vnode_ops.read = tmp_read_op;
  tmp_vnode_ops.write = tmp_write_op;
  tmp_vnode_ops.getdents = tmp_getdents_op;
  tmp_vnode_ops.stat = generic_stat_op;
  tmp_vnode_ops.truncate = tmp_truncate_op;
  tmp_vnode_ops.release = tmp_release_op;

  memset(tmp_nodes, 0, sizeof(struct tmp_node) * CFG_NTMPNODE);
}
