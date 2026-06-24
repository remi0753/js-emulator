// Read path for the on-disk filesystem (xv6-flavored), with a FIFO buffer cache
// in front of the block driver.
#include "kernel.h"

// Mounted-filesystem geometry (read from the superblock at boot).
int fs_size;
int fs_ninodes;
int fs_inodestart;
int fs_bmapstart;

// Buffer cache: NBUF slots, each holding one disk block. FIFO replacement.
int buf_block[CFG_NBUF];
int buf_valid[CFG_NBUF];
int buf_next;
char buf_data[CFG_BUF_DATA_LEN]; // NBUF * 512 bytes

char namebuf[16];   // one path component during namei
char direntbuf[16]; // one directory entry during dirlookup

int bread(int blockno) {
  int i;
  int slot;
  i = 0;
  while (i < CFG_NBUF) {
    if (buf_valid[i] != 0 && buf_block[i] == blockno) {
      return buf_data + i * 512;
    }
    i = i + 1;
  }
  slot = buf_next;
  buf_next = (buf_next + 1) % CFG_NBUF;
  disk_read_block(blockno, buf_data + slot * 512);
  buf_block[slot] = blockno;
  buf_valid[slot] = 1;
  return buf_data + slot * 512;
}

void fs_mount(void) {
  int sb;
  sb = bread(1);
  if (read32_at(sb) != CFG_FS_MAGIC) {
    panic("bad filesystem magic");
  }
  fs_size = read32_at(sb + 4);
  fs_ninodes = read32_at(sb + 8);
  fs_inodestart = read32_at(sb + 12);
  fs_bmapstart = read32_at(sb + 16);
}

int inode_addr(int inum) {
  int block;
  int off;
  block = fs_inodestart + inum / CFG_IPB;
  off = (inum % CFG_IPB) * CFG_DINODE_SIZE;
  return bread(block) + off;
}

int inode_type(int inum) {
  return read16_at(inode_addr(inum));
}

int inode_size(int inum) {
  return read32_at(inode_addr(inum) + 4);
}

int inode_slot(int inum, int k) {
  return read32_at(inode_addr(inum) + 8 + k * 4);
}

int bmap(int inum, int bn) {
  int ind;
  if (bn < CFG_NDIRECT) {
    return inode_slot(inum, bn);
  }
  ind = inode_slot(inum, CFG_NDIRECT);
  if (ind == 0) {
    return 0;
  }
  return read32_at(bread(ind) + (bn - CFG_NDIRECT) * 4);
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
  if (off > sz) {
    return 0;
  }
  end = off + n;
  if (end > sz) {
    end = sz;
  }
  pos = off;
  d = dst;
  while (pos < end) {
    within = pos % 512;
    take = 512 - within;
    if (take > end - pos) {
      take = end - pos;
    }
    blk = bmap(inum, pos / 512);
    if (blk != 0) {
      memcpy(d, bread(blk) + within, take);
    } else {
      memset(d, 0, take);
    }
    pos = pos + take;
    d = d + take;
  }
  return end - off;
}

int name_eq(int dname, int want, int wlen) {
  int k;
  int dc;
  int wc;
  k = 0;
  while (k < CFG_DIRSIZ) {
    dc = read8_at(dname + k);
    if (k < wlen) {
      wc = read8_at(want + k);
    } else {
      wc = 0;
    }
    if (dc != wc) {
      return 0;
    }
    k = k + 1;
  }
  return 1;
}

int dirlookup(int dir, int name, int namelen) {
  int sz;
  int off;
  int ent_inum;
  sz = inode_size(dir);
  off = 0;
  while (off < sz) {
    readi(dir, off, 16, direntbuf);
    ent_inum = read16_at(direntbuf);
    if (ent_inum != 0) {
      if (name_eq(direntbuf + 2, name, namelen)) {
        return ent_inum;
      }
    }
    off = off + 16;
  }
  return 0;
}

int namei(int path) {
  int inum;
  int i;
  int ni;
  int c;
  inum = CFG_ROOTINO;
  i = 0;
  while (read8_at(path + i) == '/') {
    i = i + 1;
  }
  while (read8_at(path + i) != 0) {
    ni = 0;
    c = read8_at(path + i);
    while (c != 0 && c != '/') {
      if (ni < CFG_DIRSIZ) {
        namebuf[ni] = c;
        ni = ni + 1;
      }
      i = i + 1;
      c = read8_at(path + i);
    }
    namebuf[ni] = 0;
    inum = dirlookup(inum, namebuf, ni);
    if (inum == 0) {
      return 0;
    }
    while (read8_at(path + i) == '/') {
      i = i + 1;
    }
  }
  return inum;
}
