// Physical and virtual memory management: raw memory access helpers, a free-list
// physical frame allocator, and per-process page tables.
#include "kernel.h"

int free_list;
int kernel_pt;

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

// Copy `len` bytes from user address `usrc` (in proc's address space) into the
// kernel buffer at `kdst`. The caller's page directory is live, so user memory
// is reachable directly once the range is validated.
int copyin(int proc, int kdst, int usrc, int len) {
  int i;
  if (user_access_ok(proc, usrc, len, 0) == 0) {
    return -1;
  }
  i = 0;
  while (i < len) {
    write8_at(kdst + i, read8_at(usrc + i));
    i = i + 1;
  }
  return 0;
}

// Copy `len` bytes from the kernel buffer at `ksrc` out to user address `udst`.
int copyout(int proc, int udst, int ksrc, int len) {
  int i;
  if (user_access_ok(proc, udst, len, 1) == 0) {
    return -1;
  }
  i = 0;
  while (i < len) {
    write8_at(udst + i, read8_at(ksrc + i));
    i = i + 1;
  }
  return 0;
}

// Copy a NUL-terminated string in from user memory, validating each byte. Stores
// at most `max` bytes (including the terminator) at `kdst`. Returns the string
// length (excluding the terminator) on success, or -1 on a bad address or if no
// terminator is found within `max`.
int copyinstr(int proc, int kdst, int usrc, int max) {
  int i;
  int c;
  i = 0;
  while (i < max) {
    if (user_access_ok(proc, usrc + i, 1, 0) == 0) {
      return -1;
    }
    c = read8_at(usrc + i);
    write8_at(kdst + i, c);
    if (c == 0) {
      return i;
    }
    i = i + 1;
  }
  return -1;
}

// --- physical frame allocator: a free list threaded through the free frames ---

void free_frame(int frame) {
  int *p;
  p = frame;
  p[0] = free_list;
  free_list = frame;
}

int alloc_frame(void) {
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

int free_frame_count(void) {
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

void pmm_init(void) {
  int f;
  free_list = 0;
  f = CFG_FRAME_POOL_END - 4096;
  while (f >= CFG_FRAME_POOL_BASE) {
    free_frame(f);
    f = f - 4096;
  }
}

// --- virtual memory ---

void build_kernel_pt(void) {
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

int new_address_space(void) {
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
