// Phase 16: expand devices behind stable guest drivers.
//
// Builds on the Phase 15 guest kernel (the compiled userland, executable
// loading, argv passing, the unified fd table, pipes, plus everything from the
// earlier phases). Phase 16 adds two new hardware devices and the guest drivers
// that own them, each behind a syscall the userland can call:
//
//   * a real-time clock (RTC): the time() syscall reads the current wall-clock
//     time (Unix seconds) from the RTC device port, and
//   * a power controller: the shutdown() syscall writes the power-off command to
//     the power device port, which stops the machine cleanly -- a real software
//     power-off instead of halting only when nothing is left runnable.
//
// The drivers are tiny (one port IN, one port OUT), but they establish the
// pattern for adding further devices: a hardware device model on the port bus, a
// guest driver function, and a syscall that exposes it to userland.
//
// At boot the kernel mounts the disk, reads the boot manifest, and execs
// /bin/init, which spawns /bin/sh. The shell reads commands from the keyboard
// and runs echo/cat/ls, pipelines, /bin/date (RTC), and /bin/shutdown (power) --
// all compiled C on the guest.
//
// CFG_* tokens are substituted by ../guest-kernel.ts (the single source of truth
// for the memory layout, ISA constants, syscall numbers, ports, FS format, and
// the executable header magic).

int ticks;
int current;
int nproc;
int free_list;
int kernel_pt;
int page_fault_addr;
int g_blocked; // set by a syscall that blocked the caller (don't write its R0)

// Per-process state, stored as flat arrays so the assembly trap stub can also
// reach the live trap registers through fixed global labels (sctx_*).
int proc_state[CFG_MAX_PROC]; // unused / runnable / zombie / blocked / pipewait
int proc_parent[CFG_MAX_PROC]; // parent slot, -1 for the initial process
int proc_exit_code[CFG_MAX_PROC];
int proc_ptbr[CFG_MAX_PROC];
int proc_regs[CFG_PROC_REG_COUNT]; // proc * 8 + register number
int proc_pc[CFG_MAX_PROC];
int proc_sp[CFG_MAX_PROC];
int proc_flags[CFG_MAX_PROC];
int proc_mode[CFG_MAX_PROC];

// Unified per-process file-descriptor table. Each fd has a type and, depending
// on the type, an inode + offset (files) or a pipe id + end (pipes).
int proc_fd_type[CFG_FD_TABLE_LEN]; // none / console / keyboard / file / pipe
int proc_fd_inum[CFG_FD_TABLE_LEN];
int proc_fd_off[CFG_FD_TABLE_LEN];
int proc_fd_pipe[CFG_FD_TABLE_LEN];
int proc_fd_pend[CFG_FD_TABLE_LEN]; // pipe end: 0 = read, 1 = write

// Pipes. Each is a ring buffer with reader/writer reference counts; when both
// hit zero the pipe is freed, and a write-end count of zero is EOF for readers.
int pipe_used[CFG_NPIPE];
int pipe_count[CFG_NPIPE]; // bytes currently buffered
int pipe_head[CFG_NPIPE]; // read position
int pipe_nread[CFG_NPIPE]; // open read ends
int pipe_nwrite[CFG_NPIPE]; // open write ends
char pipe_buf[CFG_PIPE_BUF_LEN]; // NPIPE * PIPESZ

// Trap-frame scratch shared with the assembly trap/context-switch stubs.
int sctx_r0; int sctx_r1; int sctx_r2; int sctx_r3;
int sctx_r4; int sctx_r5; int sctx_r6; int sctx_r7;
int sctx_pc; int sctx_sp; int sctx_flags; int sctx_mode;

// Captured addresses of the assembly trap stubs (filled by capture_handlers()).
int default_handler_addr;
int timer_handler_addr;
int pf_handler_addr;
int syscall_handler_addr;
int keyboard_handler_addr;

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

// Kernel scratch (the syscall path is non-reentrant -- interrupts are masked in
// handlers -- so single global buffers are safe).
char initpath[CFG_INITPATH_LEN];
char kpath[CFG_INITPATH_LEN]; // a path copied in from user memory
char namebuf[16]; // one path component during namei
char direntbuf[16]; // one directory entry during dirlookup
char exec_hdr[12]; // the executable header (magic, entry, memSize)
char argbuf[CFG_ARGBUF_LEN]; // packed NUL-terminated argv strings
int arg_off[CFG_MAXARG]; // start offset of each arg in argbuf
int g_argc; // argument count staged for the next spawn

void serial_putc(int ch) {
  __out(CFG_CONSOLE_DATA, ch);
}

void serial_write(char *s) {
  int i;
  i = 0;
  while (s[i] != 0) {
    serial_putc(s[i]);
    i = i + 1;
  }
}

void panic(char *msg) {
  serial_write("phase16: PANIC: ");
  serial_write(msg);
  serial_putc('\n');
  __di();
  __halt();
}

// --- RTC + power drivers (Phase 16) ---

// Read the wall-clock time (Unix seconds) from the RTC device port.
int rtc_time() {
  return __in(CFG_RTC_DATA);
}

// Write the power-off command to the power device; the machine stops cleanly.
void power_off() {
  __out(CFG_POWER, CFG_POWER_OFF);
}

void zero_page(int addr) {
  memset(addr, 0, 4096);
}

void copy_page(int src, int dst) {
  memcpy(dst, src, 4096);
}

int read32_at(int addr) {
  int *p;
  p = addr;
  return p[0];
}

int read16_at(int addr) {
  char *p;
  p = addr;
  return p[0] | (p[1] << 8);
}

int read8_at(int addr) {
  char *p;
  p = addr;
  return p[0];
}

void write32_at(int addr, int v) {
  int *p;
  p = addr;
  p[0] = v;
}

void write8_at(int addr, int v) {
  char *p;
  p = addr;
  p[0] = v;
}

int user_access_ok(int proc, int addr, int len, int write) {
  int *pd;
  int pde;
  int *pt;
  int pte;
  int page;
  int last;
  if (len < 0 || addr < CFG_USER_BASE || addr > CFG_USER_END) {
    return 0;
  }
  if (len > CFG_USER_END - addr) {
    return 0;
  }
  if (len == 0) {
    return 1;
  }
  page = addr & 0xfffff000;
  last = (addr + len - 1) & 0xfffff000;
  pd = proc_ptbr[proc];
  while (page <= last) {
    pde = pd[(page >> 22) & 0x3ff];
    if ((pde & 5) != 5) {
      return 0;
    }
    pt = pde & 0xfffff000;
    pte = pt[(page >> 12) & 0x3ff];
    if ((pte & 5) != 5) {
      return 0;
    }
    if (write != 0 && (pte & 2) == 0) {
      return 0;
    }
    page = page + 4096;
  }
  return 1;
}

// --- physical frame allocator: a free list threaded through the free frames ---

void free_frame(int frame) {
  int *p;
  p = frame;
  p[0] = free_list;
  free_list = frame;
}

int alloc_frame() {
  int frame;
  int *p;
  if (free_list == 0) {
    panic("out of physical frames");
  }
  frame = free_list;
  p = frame;
  free_list = p[0];
  return frame;
}

int free_frame_count() {
  int n;
  int frame;
  int *p;
  n = 0;
  frame = free_list;
  while (frame != 0) {
    n = n + 1;
    p = frame;
    frame = p[0];
  }
  return n;
}

void pmm_init() {
  int f;
  free_list = 0;
  f = CFG_FRAME_POOL_END - 4096;
  while (f >= CFG_FRAME_POOL_BASE) {
    free_frame(f);
    f = f - 4096;
  }
}

// --- block driver + buffer cache ---

void disk_read_block(int blockno, int dst) {
  int *p;
  int i;
  __out(CFG_DISK_POS, blockno);
  p = dst;
  i = 0;
  while (i < 128) { // 512 bytes / 4 bytes per word
    p[i] = __in(CFG_DISK_DATA);
    i = i + 1;
  }
}

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

// --- filesystem read path (xv6-flavored on-disk format) ---

void fs_mount() {
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

// --- virtual memory ---

void build_kernel_pt() {
  int *pt;
  int i;
  pt = CFG_KERNEL_PT;
  i = 0;
  while (i < 1024) {
    pt[i] = (i * 4096) | CFG_PTE_KERNEL;
    i = i + 1;
  }
  kernel_pt = CFG_KERNEL_PT;
}

int new_address_space() {
  int pd;
  int *p;
  pd = alloc_frame();
  zero_page(pd);
  p = pd;
  p[0] = kernel_pt | CFG_PTE_KERNEL; // share the kernel identity map
  return pd;
}

void map_page(int pd, int vaddr, int frame, int flags) {
  int *pdp;
  int pde;
  int pt;
  int *ptp;
  pdp = pd;
  pde = pdp[(vaddr >> 22) & 0x3ff];
  if ((pde & 1) == 0) {
    pt = alloc_frame();
    zero_page(pt);
    pde = pt | CFG_PTE_USER;
    pdp[(vaddr >> 22) & 0x3ff] = pde;
  }
  ptp = pde & 0xfffff000;
  ptp[(vaddr >> 12) & 0x3ff] = (frame & 0xfffff000) | flags | 1;
}

void copy_space(int src, int dst) {
  int *sp;
  int di;
  int spde;
  int *spt;
  int ti;
  int spte;
  int frame;
  int v;
  sp = src;
  di = 1;
  while (di < 1024) {
    spde = sp[di];
    if ((spde & 1) != 0) {
      spt = spde & 0xfffff000;
      ti = 0;
      while (ti < 1024) {
        spte = spt[ti];
        if ((spte & 1) != 0) {
          frame = alloc_frame();
          copy_page(spte & 0xfffff000, frame);
          v = (di << 22) | (ti << 12);
          map_page(dst, v, frame, spte & 7);
        }
        ti = ti + 1;
      }
    }
    di = di + 1;
  }
}

void free_space(int pd) {
  int *pdp;
  int di;
  int pde;
  int *ptp;
  int ti;
  int pte;
  pdp = pd;
  di = 1;
  while (di < 1024) {
    pde = pdp[di];
    if ((pde & 1) != 0) {
      ptp = pde & 0xfffff000;
      ti = 0;
      while (ti < 1024) {
        pte = ptp[ti];
        if ((pte & 1) != 0) {
          free_frame(pte & 0xfffff000);
        }
        ti = ti + 1;
      }
      free_frame(pde & 0xfffff000);
    }
    di = di + 1;
  }
  free_frame(pd);
}

// --- file descriptors + pipes ---

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

int alloc_pipe() {
  int i;
  i = 0;
  while (i < CFG_NPIPE) {
    if (pipe_used[i] == 0) {
      pipe_used[i] = 1;
      pipe_count[i] = 0;
      pipe_head[i] = 0;
      pipe_nread[i] = 1;
      pipe_nwrite[i] = 1;
      return i;
    }
    i = i + 1;
  }
  return -1;
}

int pipe_write_bytes(int pp, int buf, int len) {
  int space;
  int n;
  int k;
  int idx;
  space = CFG_PIPESZ - pipe_count[pp];
  n = len;
  if (n > space) {
    n = space;
  }
  k = 0;
  while (k < n) {
    idx = (pipe_head[pp] + pipe_count[pp]) % CFG_PIPESZ;
    pipe_buf[pp * CFG_PIPESZ + idx] = read8_at(buf + k);
    pipe_count[pp] = pipe_count[pp] + 1;
    k = k + 1;
  }
  return n;
}

int pipe_read_bytes(int pp, int buf, int len) {
  int n;
  int k;
  n = len;
  if (n > pipe_count[pp]) {
    n = pipe_count[pp];
  }
  k = 0;
  while (k < n) {
    write8_at(buf + k, pipe_buf[pp * CFG_PIPESZ + pipe_head[pp]]);
    pipe_head[pp] = (pipe_head[pp] + 1) % CFG_PIPESZ;
    pipe_count[pp] = pipe_count[pp] - 1;
    k = k + 1;
  }
  return n;
}

// Wake every process blocked on a pipe so it can re-check (data arrived, or a
// write end closed, signaling EOF).
void wake_pipe_waiters() {
  int i;
  i = 0;
  while (i < nproc) {
    if (proc_state[i] == CFG_ST_PIPEWAIT) {
      proc_state[i] = CFG_ST_RUNNABLE;
    }
    i = i + 1;
  }
}

// --- processes ---

int alloc_proc() {
  int i;
  i = 0;
  while (i < nproc) {
    if (proc_state[i] == CFG_ST_UNUSED) {
      return i;
    }
    i = i + 1;
  }
  if (nproc >= CFG_MAX_PROC) {
    panic("too many processes");
  }
  i = nproc;
  nproc = nproc + 1;
  return i;
}

// Copy a NUL-terminated path from user memory into the kpath kernel buffer.
int copy_path_in(int proc, int upath) {
  int i;
  int c;
  i = 0;
  while (i < CFG_INITPATH_LEN) {
    if (user_access_ok(proc, upath + i, 1, 0) == 0) {
      return -1;
    }
    c = read8_at(upath + i);
    if (c == 0) {
      kpath[i] = 0;
      return 0;
    }
    if (i == CFG_INITPATH_LEN - 1) {
      return -1;
    }
    kpath[i] = c;
    i = i + 1;
  }
  return -1;
}

// Stage a single argument (used at boot: argv = { path }).
void build_args_single(int kstr) {
  int total;
  int c;
  arg_off[0] = 0;
  total = 0;
  c = read8_at(kstr + total);
  while (c != 0) {
    argbuf[total] = c;
    total = total + 1;
    c = read8_at(kstr + total);
  }
  argbuf[total] = 0;
  g_argc = 1;
}

// Stage argv copied from a user char*[] (NULL-terminated) into argbuf.
int build_args_from_user(int proc, int uargv) {
  int argc;
  int total;
  int ptr;
  int j;
  int c;
  argc = 0;
  total = 0;
  if (uargv != 0) {
    while (argc < CFG_MAXARG) {
      if (user_access_ok(proc, uargv + argc * 4, 4, 0) == 0) {
        return -1;
      }
      ptr = read32_at(uargv + argc * 4);
      if (ptr == 0) {
        break;
      }
      if (total >= CFG_ARGBUF_LEN) {
        return -1;
      }
      arg_off[argc] = total;
      j = 0;
      if (user_access_ok(proc, ptr, 1, 0) == 0) {
        return -1;
      }
      c = read8_at(ptr);
      while (c != 0) {
        if (total >= CFG_ARGBUF_LEN - 1) {
          return -1;
        }
        argbuf[total] = c;
        total = total + 1;
        j = j + 1;
        if (user_access_ok(proc, ptr + j, 1, 0) == 0) {
          return -1;
        }
        c = read8_at(ptr + j);
      }
      argbuf[total] = 0;
      total = total + 1;
      argc = argc + 1;
    }
    if (argc == CFG_MAXARG) {
      if (user_access_ok(proc, uargv + argc * 4, 4, 0) == 0) {
        return -1;
      }
      if (read32_at(uargv + argc * 4) != 0) {
        return -1;
      }
    }
  }
  g_argc = argc;
  return 0;
}

// Load an executable into a fresh address space: read the header, map enough
// pages for the whole memory image (text + data + bss), and copy in the file
// bytes (bss tail stays zero). Returns the entry virtual address.
int load_exec_image(int pd, int path) {
  int inum;
  int entry;
  int memsz;
  int npages;
  int i;
  int frame;
  inum = namei(path);
  if (inum == 0) {
    return -1;
  }
  if (inode_type(inum) != CFG_T_FILE) {
    return -1;
  }
  if (inode_size(inum) < 12 || readi(inum, 0, 12, exec_hdr) != 12) {
    return -1;
  }
  if (read32_at(exec_hdr) != CFG_EXEC_MAGIC) {
    return -1;
  }
  entry = read32_at(exec_hdr + 4);
  memsz = read32_at(exec_hdr + 8);
  if (memsz <= 0 || memsz > CFG_USER_STACK_PAGE - CFG_USER_LOAD_BASE) {
    return -1;
  }
  if (inode_size(inum) - 12 > memsz) {
    return -1;
  }
  if (entry < CFG_USER_LOAD_BASE || entry >= CFG_USER_LOAD_BASE + memsz) {
    return -1;
  }
  npages = (memsz + 4095) / 4096;
  if (npages + 2 > free_frame_count()) {
    return -1;
  }
  i = 0;
  while (i < npages) {
    frame = alloc_frame();
    zero_page(frame);
    // file bytes after the 12-byte header map to USER_LOAD_BASE upward
    readi(inum, 12 + i * 4096, 4096, frame);
    map_page(pd, CFG_USER_LOAD_BASE + i * 4096, frame, CFG_PTE_USER);
    i = i + 1;
  }
  return entry;
}

// Build the user stack page and lay out argv on it: strings near the top, then a
// NULL-terminated argv[] pointer array. Sets the new process's R0 = argc,
// R1 = argv, and the hardware sp just below the argv array.
int setup_user_args(int idx, int pd) {
  int sframe;
  int total;
  int strbase;
  int argvaddr;
  int i;
  int avaddr;
  sframe = alloc_frame();
  zero_page(sframe);
  map_page(pd, CFG_USER_STACK_PAGE, sframe, CFG_PTE_USER);

  total = 0;
  if (g_argc > 0) {
    total = arg_off[g_argc - 1];
    while (argbuf[total] != 0) {
      total = total + 1;
    }
    total = total + 1; // include the final string's NUL
  }
  strbase = (CFG_USER_STACK_TOP - total) & 0xfffffffc;
  if (total > 0) {
    memcpy(sframe + (strbase - CFG_USER_STACK_PAGE), argbuf, total);
  }
  argvaddr = (strbase - (g_argc + 1) * 4) & 0xfffffffc;
  if (argvaddr <= CFG_USER_STACK_PAGE) {
    return -1;
  }
  i = 0;
  while (i < g_argc) {
    avaddr = strbase + arg_off[i];
    write32_at(sframe + (argvaddr - CFG_USER_STACK_PAGE) + i * 4, avaddr);
    i = i + 1;
  }
  write32_at(sframe + (argvaddr - CFG_USER_STACK_PAGE) + g_argc * 4, 0);

  proc_regs[idx * 8 + 0] = g_argc; // R0 = argc
  proc_regs[idx * 8 + 1] = argvaddr; // R1 = argv
  i = 2;
  while (i < 8) {
    proc_regs[idx * 8 + i] = 0;
    i = i + 1;
  }
  proc_sp[idx] = argvaddr; // hardware stack grows down, below the args
  return 0;
}

// Build a new address space for slot idx running the program at `path` (a kernel
// address) with the argv currently staged in argbuf. Does not touch fds.
int spawn(int idx, int path) {
  int pd;
  int entry;
  if (free_list == 0) {
    return -1;
  }
  pd = new_address_space();
  entry = load_exec_image(pd, path);
  if (entry < 0) {
    free_space(pd);
    return -1;
  }
  if (setup_user_args(idx, pd) < 0) {
    free_space(pd);
    return -1;
  }
  proc_ptbr[idx] = pd;
  proc_pc[idx] = entry;
  proc_mode[idx] = CFG_MODE_USER;
  proc_flags[idx] = CFG_FLAG_IF;
  return 0;
}

int setup_process_boot(int path) {
  int idx;
  idx = alloc_proc();
  build_args_single(path);
  if (spawn(idx, path) < 0) {
    panic("boot: invalid init executable");
  }
  proc_parent[idx] = -1;
  proc_state[idx] = CFG_ST_RUNNABLE;
  init_fds(idx);
  return idx;
}

int fork_process(int parent) {
  int idx;
  int pd;
  int i;
  if (parent < 0 || parent >= nproc || proc_state[parent] == CFG_ST_UNUSED) {
    panic("bad fork parent");
  }
  idx = alloc_proc();
  pd = new_address_space();
  copy_space(proc_ptbr[parent], pd);
  proc_ptbr[idx] = pd;
  i = 0;
  while (i < 8) {
    proc_regs[idx * 8 + i] = proc_regs[parent * 8 + i];
    i = i + 1;
  }
  proc_pc[idx] = proc_pc[parent];
  proc_sp[idx] = proc_sp[parent];
  proc_mode[idx] = proc_mode[parent];
  proc_flags[idx] = proc_flags[parent];
  return idx;
}

// --- scheduler ---

void save_ctx(int i) {
  int b;
  b = i * 8;
  proc_regs[b + 0] = sctx_r0;
  proc_regs[b + 1] = sctx_r1;
  proc_regs[b + 2] = sctx_r2;
  proc_regs[b + 3] = sctx_r3;
  proc_regs[b + 4] = sctx_r4;
  proc_regs[b + 5] = sctx_r5;
  proc_regs[b + 6] = sctx_r6;
  proc_regs[b + 7] = sctx_r7;
  proc_pc[i] = sctx_pc;
  proc_sp[i] = sctx_sp;
  proc_flags[i] = sctx_flags;
  proc_mode[i] = sctx_mode;
}

void load_ctx(int i) {
  int b;
  b = i * 8;
  sctx_r0 = proc_regs[b + 0];
  sctx_r1 = proc_regs[b + 1];
  sctx_r2 = proc_regs[b + 2];
  sctx_r3 = proc_regs[b + 3];
  sctx_r4 = proc_regs[b + 4];
  sctx_r5 = proc_regs[b + 5];
  sctx_r6 = proc_regs[b + 6];
  sctx_r7 = proc_regs[b + 7];
  sctx_pc = proc_pc[i];
  sctx_sp = proc_sp[i];
  sctx_flags = proc_flags[i];
  sctx_mode = proc_mode[i];
}

int schedule() {
  int n;
  int idx;
  n = 0;
  while (n < nproc) {
    idx = (current + 1 + n) % nproc;
    if (proc_state[idx] == CFG_ST_RUNNABLE) {
      return idx;
    }
    n = n + 1;
  }
  return -1;
}

void switch_to_next() {
  int next;
  next = schedule();
  while (next < 0) {
    int i;
    int blocked;
    i = 0;
    blocked = 0;
    while (i < nproc) {
      if (proc_state[i] == CFG_ST_BLOCKED || proc_state[i] == CFG_ST_PIPEWAIT) {
        blocked = 1;
      }
      i = i + 1;
    }
    if (blocked == 0) {
      serial_write("phase16: all processes exited\n");
      __halt();
    }
    __stmr(0);
    __ei();
    __halt();
    __di();
    next = schedule();
  }
  __stmr(CFG_TIMER_PERIOD);
  current = next;
}

void on_timer() {
  int next;
  if (sctx_mode != CFG_MODE_USER) {
    panic("timer outside user");
  }
  ticks = ticks + 1;
  save_ctx(current);
  next = schedule();
  if (next < 0) {
    panic("no runnable process in timer");
  }
  current = next;
  load_ctx(current);
  __lptbr(proc_ptbr[current]);
}

void on_default_trap() {
  panic("unexpected trap");
}

void on_page_fault() {
  page_fault_addr = __rdpfla();
  panic("unexpected page fault");
}

// --- syscalls ---

int sys_write(int caller, int fd, int buf, int len) {
  char *p;
  int i;
  int base;
  int t;
  int pp;
  int n;
  if (len < 0) {
    return -1;
  }
  if (user_access_ok(caller, buf, len, 0) == 0) {
    return -1;
  }
  if (fd < 0 || fd >= CFG_NFD) {
    return -1;
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
      return -1; // broken pipe: no readers
    }
    if (pipe_count[pp] == CFG_PIPESZ) {
      g_blocked = 1;
      proc_pc[caller] = proc_pc[caller] - CFG_SYSCALL_INSTR_SIZE;
      proc_state[caller] = CFG_ST_PIPEWAIT;
      switch_to_next();
      return 0;
    }
    n = pipe_write_bytes(pp, buf, len);
    wake_pipe_waiters();
    return n;
  }
  return -1;
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
    return -1;
  }
  if (user_access_ok(caller, buf, len, 1) == 0) {
    return -1;
  }
  if (fd < 0 || fd >= CFG_NFD) {
    return -1;
  }
  base = caller * CFG_NFD;
  t = proc_fd_type[base + fd];
  if (t == CFG_FT_KBD) {
    if (len == 0) {
      return 0;
    }
    ch = __in(CFG_KBD_DATA);
    if (ch == 0) {
      if ((__in(CFG_KBD_STATUS) & 2) != 0) {
        return 0;
      }
      g_blocked = 1;
      proc_pc[caller] = proc_pc[caller] - CFG_SYSCALL_INSTR_SIZE;
      proc_state[caller] = CFG_ST_PIPEWAIT;
      switch_to_next();
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
      wake_pipe_waiters();
      return n;
    }
    if (pipe_nwrite[pp] == 0) {
      return 0; // EOF: no data and no writers
    }
    // Block: rewind to re-execute INT 0x80 when a writer wakes us.
    g_blocked = 1;
    proc_pc[caller] = proc_pc[caller] - CFG_SYSCALL_INSTR_SIZE;
    proc_state[caller] = CFG_ST_PIPEWAIT;
    switch_to_next();
    return 0;
  }
  return -1;
}

int sys_open(int caller, int upath, int flags) {
  int inum;
  int t;
  int fd;
  int base;
  if (copy_path_in(caller, upath) < 0) {
    return -1;
  }
  inum = namei(kpath);
  if (inum == 0) {
    return -1;
  }
  t = inode_type(inum);
  if (t != CFG_T_FILE && t != CFG_T_DIR) {
    return -1;
  }
  fd = alloc_fd(caller);
  if (fd < 0) {
    return -1;
  }
  base = caller * CFG_NFD;
  proc_fd_type[base + fd] = CFG_FT_FILE;
  proc_fd_inum[base + fd] = inum;
  proc_fd_off[base + fd] = 0;
  return fd;
}

int sys_close(int caller, int fd) {
  if (fd < 0 || fd >= CFG_NFD) {
    return -1;
  }
  if (proc_fd_type[caller * CFG_NFD + fd] == CFG_FT_NONE) {
    return -1;
  }
  fd_close(caller, fd);
  wake_pipe_waiters();
  return 0;
}

int sys_pipe(int caller, int ufds) {
  int pp;
  int rfd;
  int wfd;
  int base;
  if (user_access_ok(caller, ufds, 8, 1) == 0) {
    return -1;
  }
  pp = alloc_pipe();
  if (pp < 0) {
    return -1;
  }
  base = caller * CFG_NFD;
  rfd = alloc_fd(caller);
  if (rfd < 0) {
    pipe_used[pp] = 0;
    return -1;
  }
  proc_fd_type[base + rfd] = CFG_FT_PIPE;
  proc_fd_pipe[base + rfd] = pp;
  proc_fd_pend[base + rfd] = 0;
  wfd = alloc_fd(caller);
  if (wfd < 0) {
    proc_fd_type[base + rfd] = CFG_FT_NONE;
    pipe_used[pp] = 0;
    return -1;
  }
  proc_fd_type[base + wfd] = CFG_FT_PIPE;
  proc_fd_pipe[base + wfd] = pp;
  proc_fd_pend[base + wfd] = 1;
  write32_at(ufds, rfd);
  write32_at(ufds + 4, wfd);
  return 0;
}

int sys_dup(int caller, int oldfd) {
  int base;
  int t;
  int newfd;
  int pp;
  if (oldfd < 0 || oldfd >= CFG_NFD) {
    return -1;
  }
  base = caller * CFG_NFD;
  t = proc_fd_type[base + oldfd];
  if (t == CFG_FT_NONE) {
    return -1;
  }
  newfd = alloc_fd(caller);
  if (newfd < 0) {
    return -1;
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

int do_fork(int parent) {
  int idx;
  idx = fork_process(parent);
  proc_parent[idx] = parent;
  proc_state[idx] = CFG_ST_RUNNABLE;
  copy_fds(idx, parent);
  proc_regs[idx * 8 + 0] = 0; // child sees fork() == 0
  return idx;
}

int do_exec(int idx, int upath, int uargv) {
  int old_pd;
  if (copy_path_in(idx, upath) < 0) {
    proc_regs[idx * 8 + 0] = -1;
    return 0;
  }
  if (build_args_from_user(idx, uargv) < 0) {
    proc_regs[idx * 8 + 0] = -1;
    return 0;
  }
  old_pd = proc_ptbr[idx];
  if (spawn(idx, kpath) < 0) {
    proc_regs[idx * 8 + 0] = -1;
    return 0;
  }
  return old_pd;
}

int do_exit(int idx, int code) {
  int p;
  proc_exit_code[idx] = code;
  clear_fds(idx);
  wake_pipe_waiters(); // closing write ends may signal EOF to readers
  proc_state[idx] = CFG_ST_ZOMBIE;
  p = proc_parent[idx];
  if (p >= 0 && proc_state[p] == CFG_ST_BLOCKED) {
    proc_regs[p * 8 + 0] = idx;
    proc_state[p] = CFG_ST_RUNNABLE;
    proc_state[idx] = CFG_ST_UNUSED;
    return proc_ptbr[idx];
  }
  return 0;
}

int do_wait(int parent) {
  int i;
  int alive;
  i = 0;
  while (i < nproc) {
    if (proc_parent[i] == parent && proc_state[i] == CFG_ST_ZOMBIE) {
      proc_regs[parent * 8 + 0] = i;
      proc_state[i] = CFG_ST_UNUSED;
      return proc_ptbr[i];
    }
    i = i + 1;
  }
  alive = 0;
  i = 0;
  while (i < nproc) {
    if (proc_parent[i] == parent && proc_state[i] != CFG_ST_UNUSED) {
      alive = 1;
    }
    i = i + 1;
  }
  if (alive == 0) {
    proc_regs[parent * 8 + 0] = -1;
    return 0;
  }
  proc_state[parent] = CFG_ST_BLOCKED;
  switch_to_next();
  return 0;
}

void on_syscall() {
  int caller;
  int num;
  int a1;
  int a2;
  int a3;
  int pending_free;
  int rv;
  if (sctx_mode != CFG_MODE_USER) {
    panic("syscall outside user");
  }
  pending_free = 0;
  g_blocked = 0;
  caller = current;
  save_ctx(caller);
  num = proc_regs[caller * 8 + 0];
  a1 = proc_regs[caller * 8 + 1];
  a2 = proc_regs[caller * 8 + 2];
  a3 = proc_regs[caller * 8 + 3];

  if (num == CFG_SYS_EXIT) {
    pending_free = do_exit(caller, a1);
    switch_to_next();
  } else if (num == CFG_SYS_WRITE) {
    rv = sys_write(caller, a1, a2, a3);
    if (g_blocked == 0) {
      proc_regs[caller * 8 + 0] = rv;
    }
  } else if (num == CFG_SYS_READ) {
    rv = sys_read(caller, a1, a2, a3);
    if (g_blocked == 0) {
      proc_regs[caller * 8 + 0] = rv;
    }
  } else if (num == CFG_SYS_YIELD) {
    proc_regs[caller * 8 + 0] = 0;
    switch_to_next();
  } else if (num == CFG_SYS_GETPID) {
    proc_regs[caller * 8 + 0] = caller;
  } else if (num == CFG_SYS_FORK) {
    proc_regs[caller * 8 + 0] = do_fork(caller);
  } else if (num == CFG_SYS_EXEC) {
    pending_free = do_exec(caller, a1, a2);
  } else if (num == CFG_SYS_WAIT) {
    pending_free = do_wait(caller);
  } else if (num == CFG_SYS_OPEN) {
    proc_regs[caller * 8 + 0] = sys_open(caller, a1, a2);
  } else if (num == CFG_SYS_CLOSE) {
    proc_regs[caller * 8 + 0] = sys_close(caller, a1);
  } else if (num == CFG_SYS_PIPE) {
    proc_regs[caller * 8 + 0] = sys_pipe(caller, a1);
  } else if (num == CFG_SYS_DUP) {
    proc_regs[caller * 8 + 0] = sys_dup(caller, a1);
  } else if (num == CFG_SYS_TIME) {
    proc_regs[caller * 8 + 0] = rtc_time();
  } else if (num == CFG_SYS_SHUTDOWN) {
    serial_write("phase16: shutdown\n");
    power_off(); // the machine stops at the next instruction boundary
  } else {
    proc_regs[caller * 8 + 0] = -1;
  }

  load_ctx(current);
  __lptbr(proc_ptbr[current]);
  if (pending_free != 0) {
    free_space(pending_free);
  }
}

// --- trap table ---

void set_idt_entry(int vector, int handler) {
  int *entry;
  entry = CFG_IDT + vector * CFG_IDT_ENTRY_SIZE;
  entry[0] = handler;
  entry[1] = CFG_IDT_PRESENT;
}

void set_user_idt_entry(int vector, int handler) {
  int *entry;
  entry = CFG_IDT + vector * CFG_IDT_ENTRY_SIZE;
  entry[0] = handler;
  entry[1] = CFG_IDT_PRESENT | CFG_IDT_USER;
}

void capture_handlers() {
  asm("
    MOV R1, phase16_default_handler
    STORE R1, default_handler_addr
    MOV R1, phase16_timer_handler
    STORE R1, timer_handler_addr
    MOV R1, phase16_pf_handler
    STORE R1, pf_handler_addr
    MOV R1, phase16_syscall_handler
    STORE R1, syscall_handler_addr
    MOV R1, phase16_keyboard_handler
    STORE R1, keyboard_handler_addr
  ");
}

void setup_traps() {
  int v;
  capture_handlers();
  __lidt(CFG_IDT);
  v = 0;
  while (v < 256) {
    set_idt_entry(v, default_handler_addr);
    v = v + 1;
  }
  set_idt_entry(CFG_TIMER_VECTOR, timer_handler_addr);
  set_idt_entry(CFG_PAGEFAULT_VECTOR, pf_handler_addr);
  set_idt_entry(CFG_KBD_VECTOR, keyboard_handler_addr);
  set_user_idt_entry(CFG_SYSCALL_VECTOR, syscall_handler_addr);
  __lksp(CFG_KSTACK_TOP);
}

void read_initpath() {
  int bb;
  int len;
  int i;
  bb = bread(0);
  if (read32_at(bb) != CFG_BOOT_MAGIC) {
    panic("not a bootable disk");
  }
  len = read32_at(bb + 20);
  if (len > CFG_INITPATH_LEN - 1) {
    len = CFG_INITPATH_LEN - 1;
  }
  i = 0;
  while (i < len) {
    initpath[i] = read8_at(bb + 24 + i);
    i = i + 1;
  }
  initpath[len] = 0;
}

int kmain() {
  asm("
    JMP phase16_handlers_done

  phase16_timer_handler:
    STORE R0, sctx_r0
    STORE R1, sctx_r1
    STORE R2, sctx_r2
    STORE R3, sctx_r3
    STORE R4, sctx_r4
    STORE R5, sctx_r5
    STORE R6, sctx_r6
    STORE R7, sctx_r7
    POP R0
    STORE R0, sctx_pc
    POP R0
    STORE R0, sctx_mode
    POP R0
    STORE R0, sctx_flags
    POP R0
    STORE R0, sctx_sp
    CALL on_timer
    JMP phase16_resume

  phase16_syscall_handler:
    STORE R0, sctx_r0
    STORE R1, sctx_r1
    STORE R2, sctx_r2
    STORE R3, sctx_r3
    STORE R4, sctx_r4
    STORE R5, sctx_r5
    STORE R6, sctx_r6
    STORE R7, sctx_r7
    POP R0
    STORE R0, sctx_pc
    POP R0
    STORE R0, sctx_mode
    POP R0
    STORE R0, sctx_flags
    POP R0
    STORE R0, sctx_sp
    CALL on_syscall
    JMP phase16_resume

  phase16_keyboard_handler:
    PUSH R0
    PUSH R1
    PUSH R2
    PUSH R3
    PUSH R4
    PUSH R5
    PUSH R6
    PUSH R7
    CALL wake_pipe_waiters
    POP R7
    POP R6
    POP R5
    POP R4
    POP R3
    POP R2
    POP R1
    POP R0
    IRET

  phase16_resume:
    LOAD R0, sctx_sp
    PUSH R0
    LOAD R0, sctx_flags
    PUSH R0
    LOAD R0, sctx_mode
    PUSH R0
    LOAD R0, sctx_pc
    PUSH R0
    LOAD R7, sctx_r7
    LOAD R6, sctx_r6
    LOAD R5, sctx_r5
    LOAD R4, sctx_r4
    LOAD R3, sctx_r3
    LOAD R2, sctx_r2
    LOAD R1, sctx_r1
    LOAD R0, sctx_r0
    IRET

  phase16_pf_handler:
    CALL on_page_fault

  phase16_default_handler:
    CALL on_default_trap

  phase16_handlers_done:
  ");

  serial_write("phase16: boot\n");
  setup_traps();
  pmm_init();
  build_kernel_pt();

  fs_mount();
  read_initpath();

  serial_write("phase16: exec ");
  serial_write(initpath);
  serial_putc('\n');
  setup_process_boot(initpath);

  __stmr(CFG_TIMER_PERIOD);
  current = 0;
  __lptbr(proc_ptbr[0]);
  __pgon();
  load_ctx(0);

  // Hand the CPU to init; from here the kernel only runs inside trap handlers
  // (the timer and INT 0x80), driving the compiled userland in guest code.
  asm("JMP phase16_resume");
  return 0;
}
