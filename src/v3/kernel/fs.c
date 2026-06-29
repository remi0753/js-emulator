// Writable xv6-flavored filesystem with Linux-shaped inode metadata.
#include "kernel.h"

int fs_size;
int fs_ninodes;
int fs_inodestart;
int fs_bmapstart;
int fs_mount_flags; // bit 0 is read-only; the boot root is mounted read/write

int buf_block[CFG_NBUF];
int buf_next;
char buf_data[CFG_BUF_DATA_LEN];

char namebuf[16];
char direntbuf[16];
int fs_lookup_error;
int fs_redirect_valid;
char fs_redirect_path[CFG_INITPATH_LEN];

int bread(int blockno) {
  int *bb;
  int *bend;
  char *data;
  int slot;
  // Scan the buffer cache by walking parallel pointers rather than indexing, so
  // the naive backend doesn't recompute base + i*N three times per slot. Empty
  // slots hold -1 (set in fs_mount); no real block number is negative, so a
  // single buf_block compare replaces the old valid-flag-plus-block-number test.
  // bread runs tens of thousands of times per compile (every inode, indirect,
  // and data block lookup), so this scan is one of the hottest kernel loops.
  bb = buf_block;
  bend = bb + CFG_NBUF;
  data = buf_data;
  while (bb < bend) {
    if (*bb == blockno) return data;
    bb = bb + 1;
    data = data + 512;
  }
  slot = buf_next;
  buf_next = (buf_next + 1) % CFG_NBUF;
  disk_read_block(blockno, buf_data + slot * 512);
  buf_block[slot] = blockno;
  return buf_data + slot * 512;
}

void bwrite(int blockno, int data) {
  disk_write_block(blockno, data);
}

void fs_mount(void) {
  int sb;
  int i;
  // Mark every buffer-cache slot empty (-1) before the first bread; bread uses
  // -1 rather than a separate valid array to recognise an unused slot.
  i = 0;
  while (i < CFG_NBUF) {
    buf_block[i] = -1;
    i = i + 1;
  }
  sb = bread(1);
  if (read32_at(sb) != CFG_FS_MAGIC) {
    panic("bad filesystem magic");
  }
  if (read32_at(sb + 20) != CFG_FS_VERSION ||
      read32_at(sb + 24) != CFG_DINODE_SIZE) {
    panic("unsupported filesystem version");
  }
  fs_size = read32_at(sb + 4);
  fs_ninodes = read32_at(sb + 8);
  fs_inodestart = read32_at(sb + 12);
  fs_bmapstart = read32_at(sb + 16);
  fs_mount_flags = 0;
}

int inode_addr(int inum) {
  int block;
  int off;
  block = fs_inodestart + inum / CFG_IPB;
  off = (inum % CFG_IPB) * CFG_DINODE_SIZE;
  return bread(block) + off;
}

int inode_block(int inum) {
  return fs_inodestart + inum / CFG_IPB;
}

int inode_type(int inum) { return read16_at(inode_addr(inum)); }
int inode_nlink(int inum) { return read16_at(inode_addr(inum) + 2); }
int inode_mode(int inum) { return read16_at(inode_addr(inum) + 4); }
int inode_uid(int inum) { return read16_at(inode_addr(inum) + 6); }
int inode_gid(int inum) { return read16_at(inode_addr(inum) + 8); }
int inode_size(int inum) { return read32_at(inode_addr(inum) + 12); }
int inode_atime(int inum) { return read32_at(inode_addr(inum) + 16); }
int inode_mtime(int inum) { return read32_at(inode_addr(inum) + 20); }
int inode_ctime(int inum) { return read32_at(inode_addr(inum) + 24); }
int inode_slot(int inum, int k) {
  return read32_at(inode_addr(inum) + 28 + k * 4);
}

void inode_set16(int inum, int offset, int value) {
  int addr;
  addr = inode_addr(inum);
  write8_at(addr + offset, value);
  write8_at(addr + offset + 1, value >> 8);
  bwrite(inode_block(inum), bread(inode_block(inum)));
}

void inode_set32(int inum, int offset, int value) {
  write32_at(inode_addr(inum) + offset, value);
  bwrite(inode_block(inum), bread(inode_block(inum)));
}

void inode_touch(int inum, int atime, int mtime, int ctime) {
  int now;
  int addr;
  now = rtc_time();
  addr = inode_addr(inum);
  if (atime != 0) write32_at(addr + 16, now);
  if (mtime != 0) write32_at(addr + 20, now);
  if (ctime != 0) write32_at(addr + 24, now);
  bwrite(inode_block(inum), bread(inode_block(inum)));
}

void disk_vnode_init(struct vnode *node, int inum) {
  node->ops = &disk_vnode_ops;
  node->fs_type = CFG_FS_DISK;
  node->object = inum;
  node->inode.inum = inum;
  node->inode.type = inode_type(inum);
  node->inode.nlink = inode_nlink(inum);
  node->inode.mode = inode_mode(inum);
  node->inode.uid = inode_uid(inum);
  node->inode.gid = inode_gid(inum);
  node->inode.size = inode_size(inum);
  node->inode.atime = inode_atime(inum);
  node->inode.mtime = inode_mtime(inum);
  node->inode.ctime = inode_ctime(inum);
}

int bitmap_addr(int blockno) {
  return bread(fs_bmapstart + blockno / 4096);
}

int bitmap_test(int blockno) {
  int data;
  int byte;
  int mask;
  data = bitmap_addr(blockno);
  byte = (blockno % 4096) / 8;
  mask = 1 << (blockno % 8);
  return (read8_at(data + byte) & mask) != 0;
}

void bitmap_set(int blockno, int used) {
  int bitmap_block;
  int data;
  int byte;
  int mask;
  int value;
  bitmap_block = fs_bmapstart + blockno / 4096;
  data = bread(bitmap_block);
  byte = (blockno % 4096) / 8;
  mask = 1 << (blockno % 8);
  value = read8_at(data + byte);
  if (used != 0) value = value | mask;
  else value = value & ~mask;
  write8_at(data + byte, value);
  bwrite(bitmap_block, data);
}

int balloc(void) {
  int blockno;
  int data;
  if ((fs_mount_flags & 1) != 0) return 0;
  blockno = 0;
  while (blockno < fs_size) {
    if (bitmap_test(blockno) == 0) {
      bitmap_set(blockno, 1);
      data = bread(blockno);
      memset(data, 0, 512);
      bwrite(blockno, data);
      return blockno;
    }
    blockno = blockno + 1;
  }
  return 0;
}

void bfree(int blockno) {
  if (blockno != 0) bitmap_set(blockno, 0);
}

int ialloc(int type, int mode) {
  int inum;
  int addr;
  int now;
  if ((fs_mount_flags & 1) != 0) return 0;
  inum = 1;
  while (inum < fs_ninodes) {
    if (inode_type(inum) == 0) {
      addr = inode_addr(inum);
      memset(addr, 0, CFG_DINODE_SIZE);
      write8_at(addr, type);
      write8_at(addr + 1, type >> 8);
      write8_at(addr + 4, mode);
      write8_at(addr + 5, mode >> 8);
      now = rtc_time();
      write32_at(addr + 16, now);
      write32_at(addr + 20, now);
      write32_at(addr + 24, now);
      bwrite(inode_block(inum), bread(inode_block(inum)));
      return inum;
    }
    inum = inum + 1;
  }
  return 0;
}

void ifree(int inum) {
  itrunc(inum);
  memset(inode_addr(inum), 0, CFG_DINODE_SIZE);
  bwrite(inode_block(inum), bread(inode_block(inum)));
}

int bmap(int inum, int bn) {
  int ind;
  int dind;
  int data;
  int outer;
  int inner;
  if (bn < CFG_NDIRECT) {
    return inode_slot(inum, bn);
  }
  if (bn >= CFG_MAXFILE) return 0;
  bn = bn - CFG_NDIRECT;
  if (bn < CFG_NINDIRECT) {
    ind = inode_slot(inum, CFG_NDIRECT);
    if (ind == 0) return 0;
    return read32_at(bread(ind) + bn * 4);
  }
  bn = bn - CFG_NINDIRECT;
  dind = inode_slot(inum, CFG_NDIRECT + 1);
  if (dind == 0) return 0;
  outer = bn / CFG_NINDIRECT;
  inner = bn % CFG_NINDIRECT;
  data = bread(dind);
  ind = read32_at(data + outer * 4);
  if (ind == 0) return 0;
  return read32_at(bread(ind) + inner * 4);
}

int bmap_alloc(int inum, int bn) {
  int addr;
  int ind;
  int dind;
  int data;
  int outer;
  int inner;
  if (bn < 0 || bn >= CFG_MAXFILE) return 0;
  addr = bmap(inum, bn);
  if (addr != 0) return addr;
  if (bn < CFG_NDIRECT) {
    addr = balloc();
    if (addr == 0) return 0;
    inode_set32(inum, 28 + bn * 4, addr);
    return addr;
  }
  bn = bn - CFG_NDIRECT;
  if (bn < CFG_NINDIRECT) {
    ind = inode_slot(inum, CFG_NDIRECT);
    if (ind == 0) {
      ind = balloc();
      if (ind == 0) return 0;
      inode_set32(inum, 28 + CFG_NDIRECT * 4, ind);
    }
    addr = balloc();
    if (addr == 0) return 0;
    data = bread(ind);
    write32_at(data + bn * 4, addr);
    bwrite(ind, data);
    return addr;
  }
  bn = bn - CFG_NINDIRECT;
  dind = inode_slot(inum, CFG_NDIRECT + 1);
  if (dind == 0) {
    dind = balloc();
    if (dind == 0) return 0;
    inode_set32(inum, 28 + (CFG_NDIRECT + 1) * 4, dind);
  }
  outer = bn / CFG_NINDIRECT;
  inner = bn % CFG_NINDIRECT;
  data = bread(dind);
  ind = read32_at(data + outer * 4);
  if (ind == 0) {
    ind = balloc();
    if (ind == 0) return 0;
    // balloc() does its own bread()s, which can evict the dind buffer from the
    // FIFO cache; the `data` pointer from bread(dind) above may now alias a
    // different block. Re-read dind before writing the new outer entry.
    data = bread(dind);
    write32_at(data + outer * 4, ind);
    bwrite(dind, data);
  }
  addr = balloc();
  if (addr == 0) return 0;
  data = bread(ind);
  write32_at(data + inner * 4, addr);
  bwrite(ind, data);
  return addr;
}

int readi(int inum, int off, int n, int dst) {
  int sz;
  int end;
  int pos;
  int d;
  int within;
  int take;
  int blk;
  sz = inode_size(inum);
  if (off < 0 || off > sz) return 0;
  end = off + n;
  if (end > sz) end = sz;
  pos = off;
  d = dst;
  while (pos < end) {
    within = pos % 512;
    take = 512 - within;
    if (take > end - pos) take = end - pos;
    blk = bmap(inum, pos / 512);
    if (blk != 0) memcpy(d, bread(blk) + within, take);
    else memset(d, 0, take);
    pos = pos + take;
    d = d + take;
  }
  if (end > off) inode_touch(inum, 1, 0, 0);
  return end - off;
}

int writei(int inum, int off, int n, int src) {
  int pos;
  int s;
  int within;
  int take;
  int blk;
  int data;
  int end;
  if ((fs_mount_flags & 1) != 0) return -CFG_EROFS;
  if (off < 0 || n < 0) return -CFG_EINVAL;
  if (off + n > CFG_MAXFILE * 512) return -CFG_EFBIG;
  pos = off;
  s = src;
  end = off + n;
  while (pos < end) {
    blk = bmap_alloc(inum, pos / 512);
    if (blk == 0) {
      if (pos == off) return -CFG_ENOSPC;
      if (pos > inode_size(inum)) inode_set32(inum, 12, pos);
      inode_touch(inum, 0, 1, 1);
      return pos - off;
    }
    within = pos % 512;
    take = 512 - within;
    if (take > end - pos) take = end - pos;
    data = bread(blk);
    memcpy(data + within, s, take);
    bwrite(blk, data);
    pos = pos + take;
    s = s + take;
  }
  if (end > inode_size(inum)) inode_set32(inum, 12, end);
  inode_touch(inum, 0, 1, 1);
  return n;
}

void itrunc(int inum) {
  int i;
  int j;
  int addr;
  int ind;
  int dind;
  int data;
  int data2;
  i = 0;
  while (i < CFG_NDIRECT) {
    addr = inode_slot(inum, i);
    if (addr != 0) {
      bfree(addr);
      inode_set32(inum, 28 + i * 4, 0);
    }
    i = i + 1;
  }
  ind = inode_slot(inum, CFG_NDIRECT);
  if (ind != 0) {
    data = bread(ind);
    i = 0;
    while (i < CFG_NINDIRECT) {
      addr = read32_at(data + i * 4);
      if (addr != 0) bfree(addr);
      i = i + 1;
    }
    bfree(ind);
    inode_set32(inum, 28 + CFG_NDIRECT * 4, 0);
  }
  dind = inode_slot(inum, CFG_NDIRECT + 1);
  if (dind != 0) {
    i = 0;
    while (i < CFG_NINDIRECT) {
      // Re-read dind each pass: the bread(ind)/bfree() below can evict the dind
      // buffer from the FIFO cache, so a `data` pointer held across the loop
      // would alias another block. (Same hazard as bmap_alloc.)
      data = bread(dind);
      ind = read32_at(data + i * 4);
      if (ind != 0) {
        data2 = bread(ind);
        j = 0;
        while (j < CFG_NINDIRECT) {
          addr = read32_at(data2 + j * 4);
          if (addr != 0) bfree(addr);
          j = j + 1;
        }
        bfree(ind);
      }
      i = i + 1;
    }
    bfree(dind);
    inode_set32(inum, 28 + (CFG_NDIRECT + 1) * 4, 0);
  }
  inode_set32(inum, 12, 0);
  inode_touch(inum, 0, 1, 1);
}

int disk_vnode_read(struct vnode *node, int off, int n, int dst) {
  return readi(node->inode.inum, off, n, dst);
}

int disk_vnode_write(struct vnode *node, int off, int n, int src) {
  int result;
  result = writei(node->inode.inum, off, n, src);
  if (result >= 0) disk_vnode_init(node, node->inode.inum);
  return result;
}

int name_eq(int dname, int want, int wlen) {
  int k;
  int dc;
  int wc;
  k = 0;
  while (k < CFG_DIRSIZ) {
    dc = read8_at(dname + k);
    if (k < wlen) wc = read8_at(want + k);
    else wc = 0;
    if (dc != wc) return 0;
    k = k + 1;
  }
  return 1;
}

int dirlookup(int dir, int name, int namelen) {
  int sz;
  int off;
  int ent_inum;
  if (inode_type(dir) != CFG_T_DIR) return 0;
  sz = inode_size(dir);
  off = 0;
  while (off < sz) {
    readi(dir, off, 16, direntbuf);
    ent_inum = read16_at(direntbuf);
    if (ent_inum != 0 && name_eq(direntbuf + 2, name, namelen)) {
      return ent_inum;
    }
    off = off + 16;
  }
  return 0;
}

int dirlink(int dir, int name, int namelen, int inum) {
  int off;
  int size;
  char entry[16];
  if (namelen <= 0 || namelen > CFG_DIRSIZ) return -CFG_ENAMETOOLONG;
  if (inode_type(dir) != CFG_T_DIR) return -CFG_ENOTDIR;
  if (dirlookup(dir, name, namelen) != 0) return -CFG_EEXIST;
  size = inode_size(dir);
  off = 0;
  while (off < size) {
    readi(dir, off, 16, entry);
    if (read16_at(entry) == 0) {
      size = off;
      off = inode_size(dir);
    } else {
      off = off + 16;
    }
  }
  memset(entry, 0, 16);
  write8_at(entry, inum);
  write8_at(entry + 1, inum >> 8);
  memcpy(entry + 2, name, namelen);
  return writei(dir, size, 16, entry);
}

int dirunlink(int dir, int name, int namelen) {
  int off;
  char entry[16];
  off = 0;
  while (off < inode_size(dir)) {
    readi(dir, off, 16, entry);
    if (read16_at(entry) != 0 && name_eq(entry + 2, name, namelen)) {
      memset(entry, 0, 16);
      return writei(dir, off, 16, entry);
    }
    off = off + 16;
  }
  return -CFG_ENOENT;
}

int dir_is_empty(int dir) {
  int off;
  int inum;
  char entry[16];
  off = 0;
  while (off < inode_size(dir)) {
    readi(dir, off, 16, entry);
    inum = read16_at(entry);
    if (inum != 0 &&
        name_eq(entry + 2, ".", 1) == 0 &&
        name_eq(entry + 2, "..", 2) == 0) {
      return 0;
    }
    off = off + 16;
  }
  return 1;
}

int namei_from_checked(
  int start, int path, int follow_final, int depth,
  int uid, int gid, int check_access
) {
  int inum;
  int next;
  int i;
  int ni;
  int c;
  int final;
  int target_len;
  int j;
  int mounted_len;
  char *mounted;
  char target[CFG_INITPATH_LEN];
  char combined[CFG_INITPATH_LEN];
  if (depth > 8) {
    fs_lookup_error = CFG_ELOOP;
    return 0;
  }
  inum = start;
  i = 0;
  if (read8_at(path) == '/') {
    inum = CFG_ROOTINO;
    while (read8_at(path + i) == '/') i = i + 1;
  }
  while (read8_at(path + i) != 0) {
    ni = 0;
    c = read8_at(path + i);
    while (c != 0 && c != '/') {
      if (ni >= CFG_DIRSIZ) {
        fs_lookup_error = CFG_ENAMETOOLONG;
        return 0;
      }
      namebuf[ni] = c;
      ni = ni + 1;
      i = i + 1;
      c = read8_at(path + i);
    }
    namebuf[ni] = 0;
    while (read8_at(path + i) == '/') i = i + 1;
    final = read8_at(path + i) == 0;
    if (inode_type(inum) != CFG_T_DIR) {
      fs_lookup_error = CFG_ENOTDIR;
      return 0;
    }
    if (check_access != 0 && inode_access(inum, uid, gid, 1) == 0) {
      fs_lookup_error = CFG_EACCES;
      return 0;
    }
    next = dirlookup(inum, namebuf, ni);
    if (next == 0) {
      fs_lookup_error = CFG_ENOENT;
      return 0;
    }
    if (inode_type(next) == CFG_T_SYMLINK &&
        (final == 0 || follow_final != 0)) {
      target_len = inode_size(next);
      if (target_len >= CFG_INITPATH_LEN) {
        fs_lookup_error = CFG_ENAMETOOLONG;
        return 0;
      }
      readi(next, 0, target_len, target);
      target[target_len] = 0;
      j = 0;
      while (j < target_len && j < CFG_INITPATH_LEN - 1) {
        combined[j] = target[j];
        j = j + 1;
      }
      if (final == 0 && j < CFG_INITPATH_LEN - 1) {
        combined[j] = '/';
        j = j + 1;
        while (read8_at(path + i) != 0 && j < CFG_INITPATH_LEN - 1) {
          combined[j] = read8_at(path + i);
          j = j + 1;
          i = i + 1;
        }
      }
      combined[j] = 0;
      if (target[0] == '/') {
        memcpy(fs_redirect_path, combined, j + 1);
        fs_redirect_valid = 1;
        return 0;
      }
      return namei_from_checked(inum, combined, follow_final, depth + 1,
        uid, gid, check_access);
    }
    mounted = vfs_mounted_path(next);
    if (mounted != 0) {
      mounted_len = strlen(mounted);
      j = 0;
      while (j < mounted_len && j < CFG_INITPATH_LEN - 1) {
        fs_redirect_path[j] = mounted[j];
        j = j + 1;
      }
      if (read8_at(path + i) != 0 && j < CFG_INITPATH_LEN - 1) {
        fs_redirect_path[j] = '/';
        j = j + 1;
      }
      while (read8_at(path + i) != 0 && j < CFG_INITPATH_LEN - 1) {
        fs_redirect_path[j] = read8_at(path + i);
        i = i + 1;
        j = j + 1;
      }
      if (read8_at(path + i) != 0) {
        fs_lookup_error = CFG_ENAMETOOLONG;
        return 0;
      }
      fs_redirect_path[j] = 0;
      fs_redirect_valid = 1;
      return 0;
    }
    inum = next;
  }
  return inum;
}

int namei(int path) {
  fs_lookup_error = CFG_ENOENT;
  fs_redirect_valid = 0;
  return namei_from_checked(CFG_ROOTINO, path, 1, 0, 0, 0, 0);
}

int namei_nofollow(int path) {
  fs_lookup_error = CFG_ENOENT;
  fs_redirect_valid = 0;
  return namei_from_checked(CFG_ROOTINO, path, 0, 0, 0, 0, 0);
}

int namei_access(int path, int follow_final, int uid, int gid) {
  fs_lookup_error = CFG_ENOENT;
  fs_redirect_valid = 0;
  return namei_from_checked(CFG_ROOTINO, path, follow_final, 0, uid, gid, 1);
}

int nameiparent(int path, int name) {
  int len;
  int end;
  int slash;
  int ni;
  int i;
  char parent[CFG_INITPATH_LEN];
  len = 0;
  while (read8_at(path + len) != 0 && len < CFG_INITPATH_LEN - 1) len = len + 1;
  end = len;
  while (end > 1 && read8_at(path + end - 1) == '/') end = end - 1;
  slash = end - 1;
  while (slash >= 0 && read8_at(path + slash) != '/') slash = slash - 1;
  ni = end - slash - 1;
  if (ni <= 0 || ni > CFG_DIRSIZ) return 0;
  i = 0;
  while (i < ni) {
    write8_at(name + i, read8_at(path + slash + 1 + i));
    i = i + 1;
  }
  write8_at(name + ni, 0);
  if (slash <= 0) return CFG_ROOTINO;
  i = 0;
  while (i < slash) {
    parent[i] = read8_at(path + i);
    i = i + 1;
  }
  parent[i] = 0;
  return namei(parent);
}

int create_inode(int path, int type, int mode) {
  int parent;
  int inum;
  int namelen;
  int result;
  char name[16];
  if ((fs_mount_flags & 1) != 0) return -CFG_EROFS;
  parent = nameiparent(path, name);
  if (parent == 0) return -CFG_ENOENT;
  if (inode_type(parent) != CFG_T_DIR) return -CFG_ENOTDIR;
  namelen = strlen(name);
  if (dirlookup(parent, name, namelen) != 0) return -CFG_EEXIST;
  if (type == CFG_T_DIR) mode = CFG_S_IFDIR | (mode & 4095);
  else if (type == CFG_T_SYMLINK) mode = CFG_S_IFLNK | 511;
  else mode = CFG_S_IFREG | (mode & 4095);
  inum = ialloc(type, mode);
  if (inum == 0) return -CFG_ENOSPC;
  if (type == CFG_T_DIR) {
    inode_set16(inum, 2, 2);
    result = dirlink(inum, ".", 1, inum);
    if (result >= 0) result = dirlink(inum, "..", 2, parent);
    if (result < 0) {
      ifree(inum);
      return result;
    }
  } else {
    inode_set16(inum, 2, 1);
  }
  result = dirlink(parent, name, namelen, inum);
  if (result < 0) {
    ifree(inum);
    return result;
  }
  if (type == CFG_T_DIR) inode_set16(parent, 2, inode_nlink(parent) + 1);
  inode_touch(parent, 0, 1, 1);
  return inum;
}

int inode_is_open(int inum) {
  return inode_open_count(inum) != 0;
}

int inode_open_count(int inum) {
  int i;
  int count;
  count = 0;
  i = 0;
  while (i < CFG_NFILE) {
    if (open_file_table[i].used != 0 &&
        open_file_table[i].vnode.fs_type == CFG_FS_DISK &&
        open_file_table[i].vnode.inode.inum == inum) count = count + 1;
    i = i + 1;
  }
  return count;
}

int unlink_path(int path, int remove_dir) {
  int parent;
  int inum;
  int type;
  int links;
  int namelen;
  char name[16];
  if ((fs_mount_flags & 1) != 0) return -CFG_EROFS;
  parent = nameiparent(path, name);
  if (parent == 0) return -CFG_ENOENT;
  if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return -CFG_EINVAL;
  namelen = strlen(name);
  inum = dirlookup(parent, name, namelen);
  if (inum == 0) return -CFG_ENOENT;
  type = inode_type(inum);
  if (remove_dir != 0) {
    if (type != CFG_T_DIR) return -CFG_ENOTDIR;
    if (dir_is_empty(inum) == 0) return -CFG_ENOTEMPTY;
  } else if (type == CFG_T_DIR) {
    return -CFG_EISDIR;
  }
  dirunlink(parent, name, namelen);
  if (type == CFG_T_DIR) inode_set16(parent, 2, inode_nlink(parent) - 1);
  links = inode_nlink(inum);
  if (type == CFG_T_DIR) links = 0;
  else links = links - 1;
  inode_set16(inum, 2, links);
  inode_touch(parent, 0, 1, 1);
  if (links == 0 && inode_is_open(inum) == 0) ifree(inum);
  return 0;
}

int link_path(int oldpath, int newpath) {
  int inum;
  int parent;
  int result;
  char name[16];
  if ((fs_mount_flags & 1) != 0) return -CFG_EROFS;
  inum = namei_nofollow(oldpath);
  if (inum == 0) return -CFG_ENOENT;
  if (inode_type(inum) == CFG_T_DIR) return -CFG_EPERM;
  parent = nameiparent(newpath, name);
  if (parent == 0) return -CFG_ENOENT;
  result = dirlink(parent, name, strlen(name), inum);
  if (result < 0) return result;
  inode_set16(inum, 2, inode_nlink(inum) + 1);
  inode_touch(inum, 0, 0, 1);
  return 0;
}

int rename_path(int oldpath, int newpath) {
  int oldparent;
  int newparent;
  int inum;
  int existing;
  int type;
  int result;
  char oldname[16];
  char newname[16];
  if ((fs_mount_flags & 1) != 0) return -CFG_EROFS;
  oldparent = nameiparent(oldpath, oldname);
  newparent = nameiparent(newpath, newname);
  if (oldparent == 0 || newparent == 0) return -CFG_ENOENT;
  if (oldparent == newparent && strcmp(oldname, newname) == 0) return 0;
  inum = dirlookup(oldparent, oldname, strlen(oldname));
  if (inum == 0) return -CFG_ENOENT;
  if (inode_type(inum) == CFG_T_DIR) {
    int ancestor;
    ancestor = newparent;
    while (ancestor != CFG_ROOTINO) {
      if (ancestor == inum) return -CFG_EINVAL;
      ancestor = dirlookup(ancestor, "..", 2);
      if (ancestor == 0) return -CFG_EINVAL;
    }
    if (ancestor == inum) return -CFG_EINVAL;
  }
  existing = dirlookup(newparent, newname, strlen(newname));
  if (existing == inum) {
    return 0;
  }
  if (existing != 0) {
    if (inode_type(existing) == CFG_T_DIR) {
      if (inode_type(inum) != CFG_T_DIR) return -CFG_EISDIR;
      if (dir_is_empty(existing) == 0) return -CFG_ENOTEMPTY;
      result = unlink_path(newpath, 1);
    } else {
      if (inode_type(inum) == CFG_T_DIR) return -CFG_ENOTDIR;
      result = unlink_path(newpath, 0);
    }
    if (result < 0) return result;
  }
  result = dirlink(newparent, newname, strlen(newname), inum);
  if (result < 0) return result;
  dirunlink(oldparent, oldname, strlen(oldname));
  type = inode_type(inum);
  if (type == CFG_T_DIR && oldparent != newparent) {
    dirunlink(inum, "..", 2);
    dirlink(inum, "..", 2, newparent);
    inode_set16(oldparent, 2, inode_nlink(oldparent) - 1);
    inode_set16(newparent, 2, inode_nlink(newparent) + 1);
  }
  inode_touch(inum, 0, 0, 1);
  return 0;
}

int symlink_path(int target, int linkpath) {
  int inum;
  int length;
  int result;
  if ((fs_mount_flags & 1) != 0) return -CFG_EROFS;
  length = strlen(target);
  if (length >= CFG_INITPATH_LEN) return -CFG_ENAMETOOLONG;
  inum = create_inode(linkpath, CFG_T_SYMLINK, 511);
  if (inum < 0) return inum;
  result = writei(inum, 0, length, target);
  if (result < 0) {
    unlink_path(linkpath, 0);
    return result;
  }
  return 0;
}

int readlink_path(int path, int dst, int size) {
  int inum;
  int length;
  inum = namei_nofollow(path);
  if (inum == 0) return -CFG_ENOENT;
  if (inode_type(inum) != CFG_T_SYMLINK) return -CFG_EINVAL;
  length = inode_size(inum);
  if (length > size) length = size;
  return readi(inum, 0, length, dst);
}

int chmod_path(int path, int mode) {
  int inum;
  int current;
  if ((fs_mount_flags & 1) != 0) return -CFG_EROFS;
  inum = namei(path);
  if (inum == 0) return -CFG_ENOENT;
  current = inode_mode(inum);
  inode_set16(inum, 4, (current & CFG_S_IFMT) | (mode & 4095));
  inode_touch(inum, 0, 0, 1);
  return 0;
}

int chown_path(int path, int uid, int gid) {
  int inum;
  if ((fs_mount_flags & 1) != 0) return -CFG_EROFS;
  inum = namei(path);
  if (inum == 0) return -CFG_ENOENT;
  if (uid >= 0) inode_set16(inum, 6, uid);
  if (gid >= 0) inode_set16(inum, 8, gid);
  inode_touch(inum, 0, 0, 1);
  return 0;
}

void inode_stat(int inum, struct guest_stat *st) {
  int size;
  size = inode_size(inum);
  st->dev = 1;
  st->ino = inum;
  st->mode = inode_mode(inum);
  st->nlink = inode_nlink(inum);
  st->uid = inode_uid(inum);
  st->gid = inode_gid(inum);
  st->rdev = 0;
  st->size = size;
  st->blksize = 512;
  st->blocks = (size + 511) / 512;
  st->atime = inode_atime(inum);
  st->mtime = inode_mtime(inum);
  st->ctime = inode_ctime(inum);
}

int inode_access(int inum, int uid, int gid, int mask) {
  int mode;
  int bits;
  mode = inode_mode(inum);
  if (uid == 0) {
    if ((mask & 1) != 0 && (mode & 73) == 0) return 0;
    return 1;
  }
  if (uid == inode_uid(inum)) bits = (mode >> 6) & 7;
  else if (gid == inode_gid(inum)) bits = (mode >> 3) & 7;
  else bits = mode & 7;
  return (bits & mask) == mask;
}
