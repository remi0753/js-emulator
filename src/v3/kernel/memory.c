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

int user_phys_addr(int proc, int addr, int write) {
  int *pd;
  int pde;
  int *pt;
  int pte;
  if (proc < 0 || proc >= nproc) {
    return -1;
  }
  pd = proc_table[proc].vm.ptbr;
  pde = pd[(addr >> 22) & 0x3ff];
  if ((pde & 5) != 5) {
    return -1;
  }
  pt = pde & 0xfffff000;
  pte = pt[(addr >> 12) & 0x3ff];
  if ((pte & 5) != 5) {
    return -1;
  }
  if (write != 0 && (pte & 2) == 0) {
    return -1;
  }
  return (pte & 0xfffff000) + (addr & 0xfff);
}

int user_access_ok(int proc, int addr, int len, int write) {
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
  while (page <= last) {
    if (user_phys_addr(proc, page, write) < 0) {
      return 0;
    }
    page = page + 4096;
  }
  return 1;
}

// Copy `len` bytes from user address `usrc` (in proc's address space) into the
// kernel buffer at `kdst`. Translation uses proc's page tables explicitly, so
// this remains correct even when proc is not the currently loaded address space.
int copyin(int proc, int kdst, int usrc, int len) {
  int i;
  int phys;
  if (user_access_ok(proc, usrc, len, 0) == 0) {
    return -CFG_EFAULT;
  }
  i = 0;
  while (i < len) {
    phys = user_phys_addr(proc, usrc + i, 0);
    write8_at(kdst + i, read8_at(phys));
    i = i + 1;
  }
  return 0;
}

// Copy `len` bytes from the kernel buffer at `ksrc` out to user address `udst`.
int copyout(int proc, int udst, int ksrc, int len) {
  int i;
  int phys;
  if (user_access_ok(proc, udst, len, 1) == 0) {
    return -CFG_EFAULT;
  }
  i = 0;
  while (i < len) {
    phys = user_phys_addr(proc, udst + i, 1);
    write8_at(phys, read8_at(ksrc + i));
    i = i + 1;
  }
  return 0;
}

// Copy a NUL-terminated string in from user memory, validating each byte. Stores
// at most `max` bytes (including the terminator) at `kdst`. Returns the string
// length (excluding the terminator) on success, -EFAULT on a bad address, or
// -E2BIG if no terminator is found within `max`.
int copyinstr(int proc, int kdst, int usrc, int max) {
  int i;
  int c;
  int phys;
  i = 0;
  while (i < max) {
    if (user_access_ok(proc, usrc + i, 1, 0) == 0) {
      return -CFG_EFAULT;
    }
    phys = user_phys_addr(proc, usrc + i, 0);
    c = read8_at(phys);
    write8_at(kdst + i, c);
    if (c == 0) {
      return i;
    }
    i = i + 1;
  }
  return -CFG_E2BIG;
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

int page_mapped(int pd, int vaddr) {
  int *pdp;
  int pde;
  int *ptp;
  pdp = pd;
  pde = pdp[(vaddr >> 22) & 0x3ff];
  if ((pde & 1) == 0) {
    return 0;
  }
  ptp = pde & 0xfffff000;
  return (ptp[(vaddr >> 12) & 0x3ff] & 1) != 0;
}

void unmap_page(int pd, int vaddr) {
  int *pdp;
  int pde;
  int *ptp;
  int slot;
  int pte;
  pdp = pd;
  pde = pdp[(vaddr >> 22) & 0x3ff];
  if ((pde & 1) == 0) {
    return;
  }
  ptp = pde & 0xfffff000;
  slot = (vaddr >> 12) & 0x3ff;
  pte = ptp[slot];
  if ((pte & 1) != 0) {
    free_frame(pte & 0xfffff000);
    ptp[slot] = 0;
  }
}

int page_align_up(int value) {
  return (value + 4095) & 0xfffff000;
}

int vm_range_free(int proc, int start, int end) {
  int page;
  page = start;
  while (page < end) {
    if (page_mapped(proc_table[proc].vm.ptbr, page) != 0) {
      return 0;
    }
    page = page + 4096;
  }
  return 1;
}

int vm_range_mapped(int proc, int start, int end) {
  int page;
  page = start;
  while (page < end) {
    if (page_mapped(proc_table[proc].vm.ptbr, page) == 0) {
      return 0;
    }
    page = page + 4096;
  }
  return 1;
}

int vm_area_slot(int proc) {
  int i;
  i = 0;
  while (i < CFG_MAX_VMAS) {
    if (proc_table[proc].vm.areas[i].used == 0) {
      return i;
    }
    i = i + 1;
  }
  return -1;
}

int vm_page_in_area(int proc, int page) {
  int i;
  i = 0;
  while (i < CFG_MAX_VMAS) {
    if (proc_table[proc].vm.areas[i].used != 0 &&
        page >= proc_table[proc].vm.areas[i].start &&
        page < proc_table[proc].vm.areas[i].end) {
      return 1;
    }
    i = i + 1;
  }
  return 0;
}

void vm_area_assign(
  int proc, int slot, int start, int end, int prot, int flags
) {
  proc_table[proc].vm.areas[slot].used = 1;
  proc_table[proc].vm.areas[slot].start = start;
  proc_table[proc].vm.areas[slot].end = end;
  proc_table[proc].vm.areas[slot].prot = prot;
  proc_table[proc].vm.areas[slot].flags = flags;
}

void vm_init(int proc, int pd, int image_end) {
  int i;
  proc_table[proc].vm.ptbr = pd;
  proc_table[proc].vm.brk_start = image_end;
  proc_table[proc].vm.brk_end = image_end;
  i = 0;
  while (i < CFG_MAX_VMAS) {
    proc_table[proc].vm.areas[i].used = 0;
    i = i + 1;
  }
}

void vm_fork(int child, int parent) {
  int i;
  proc_table[child].vm.brk_start = proc_table[parent].vm.brk_start;
  proc_table[child].vm.brk_end = proc_table[parent].vm.brk_end;
  i = 0;
  while (i < CFG_MAX_VMAS) {
    proc_table[child].vm.areas[i].used =
      proc_table[parent].vm.areas[i].used;
    proc_table[child].vm.areas[i].start =
      proc_table[parent].vm.areas[i].start;
    proc_table[child].vm.areas[i].end =
      proc_table[parent].vm.areas[i].end;
    proc_table[child].vm.areas[i].prot =
      proc_table[parent].vm.areas[i].prot;
    proc_table[child].vm.areas[i].flags =
      proc_table[parent].vm.areas[i].flags;
    i = i + 1;
  }
}

int vm_brk(int proc, int address) {
  int old_page_end;
  int new_page_end;
  int page;
  int frame;
  if (address == 0) {
    return proc_table[proc].vm.brk_end;
  }
  if (address < proc_table[proc].vm.brk_start ||
      address >= CFG_USER_STACK_PAGE) {
    return -CFG_ENOMEM;
  }
  old_page_end = page_align_up(proc_table[proc].vm.brk_end);
  new_page_end = page_align_up(address);
  if (new_page_end > old_page_end) {
    if (vm_range_free(proc, old_page_end, new_page_end) == 0) {
      return -CFG_ENOMEM;
    }
    if (free_frame_count() < (new_page_end - old_page_end) / 4096 + 1) {
      return -CFG_ENOMEM;
    }
    page = old_page_end;
    while (page < new_page_end) {
      frame = alloc_frame();
      zero_page(frame);
      map_page(proc_table[proc].vm.ptbr, page, frame, CFG_PTE_USER);
      page = page + 4096;
    }
  } else {
    page = new_page_end;
    while (page < old_page_end) {
      unmap_page(proc_table[proc].vm.ptbr, page);
      page = page + 4096;
    }
  }
  proc_table[proc].vm.brk_end = address;
  return address;
}

int vm_find_mapping(int proc, int length) {
  int start;
  int end;
  start = page_align_up(proc_table[proc].vm.brk_end);
  while (start + length <= CFG_USER_STACK_PAGE) {
    end = start + length;
    if (vm_range_free(proc, start, end) != 0) {
      return start;
    }
    start = start + 4096;
  }
  return 0;
}

int vm_mmap(int proc, int uargs) {
  int args[6];
  int address;
  int length;
  int prot;
  int flags;
  int fd;
  int offset;
  int end;
  int slot;
  int page;
  int frame;
  int got;
  if (copyin(proc, args, uargs, 24) < 0) {
    return -CFG_EFAULT;
  }
  address = args[0];
  length = args[1];
  prot = args[2];
  flags = args[3];
  fd = args[4];
  offset = args[5];
  if (length <= 0 || (prot & ~(CFG_PROT_READ | CFG_PROT_WRITE | CFG_PROT_EXEC)) != 0) {
    return -CFG_EINVAL;
  }
  if ((flags & CFG_MAP_PRIVATE) == 0 || (flags & CFG_MAP_SHARED) != 0) {
    return -CFG_EINVAL;
  }
  length = page_align_up(length);
  if ((flags & CFG_MAP_FIXED) != 0) {
    if ((address & 4095) != 0 || address < CFG_USER_BASE ||
        address + length < address || address + length > CFG_USER_STACK_PAGE) {
      return -CFG_EINVAL;
    }
    if (vm_range_free(proc, address, address + length) == 0) {
      return -CFG_EINVAL;
    }
  } else {
    address = vm_find_mapping(proc, length);
    if (address == 0) {
      return -CFG_ENOMEM;
    }
  }
  if ((flags & CFG_MAP_ANONYMOUS) == 0) {
    if (fd < 0 || fd >= CFG_NFD ||
        proc_table[proc].files[fd].type == CFG_FT_NONE) {
      return -CFG_EBADF;
    }
    if ((offset & 4095) != 0 || offset < 0) {
      return -CFG_EINVAL;
    }
  }
  slot = vm_area_slot(proc);
  if (slot < 0 || free_frame_count() < length / 4096 + 1) {
    return -CFG_ENOMEM;
  }
  end = address + length;
  page = address;
  while (page < end) {
    frame = alloc_frame();
    zero_page(frame);
    if ((flags & CFG_MAP_ANONYMOUS) == 0) {
      got = file_mmap_read(&proc_table[proc].files[fd],
        offset + page - address, 4096, frame);
      if (got < 0) {
        while (page > address) {
          page = page - 4096;
          unmap_page(proc_table[proc].vm.ptbr, page);
        }
        free_frame(frame);
        return got;
      }
    }
    if ((prot & CFG_PROT_WRITE) != 0) {
      map_page(proc_table[proc].vm.ptbr, page, frame, CFG_PTE_USER);
    } else if (prot == CFG_PROT_NONE) {
      map_page(proc_table[proc].vm.ptbr, page, frame, 0);
    } else {
      map_page(proc_table[proc].vm.ptbr, page, frame, 4);
    }
    page = page + 4096;
  }
  proc_table[proc].vm.areas[slot].used = 1;
  proc_table[proc].vm.areas[slot].start = address;
  proc_table[proc].vm.areas[slot].end = end;
  proc_table[proc].vm.areas[slot].prot = prot;
  proc_table[proc].vm.areas[slot].flags = flags;
  return address;
}

int vm_munmap(int proc, int address, int length) {
  int start;
  int end;
  int page;
  int i;
  int split;
  int needs_split;
  if ((address & 4095) != 0 || length <= 0) {
    return -CFG_EINVAL;
  }
  start = address;
  end = address + page_align_up(length);
  if (start < CFG_USER_BASE || end < start || end > CFG_USER_STACK_PAGE) {
    return -CFG_EINVAL;
  }
  needs_split = 0;
  i = 0;
  while (i < CFG_MAX_VMAS) {
    if (proc_table[proc].vm.areas[i].used != 0 &&
        start > proc_table[proc].vm.areas[i].start &&
        end < proc_table[proc].vm.areas[i].end) {
      needs_split = 1;
    }
    i = i + 1;
  }
  if (needs_split != 0 && vm_area_slot(proc) < 0) {
    return -CFG_ENOMEM;
  }
  page = start;
  while (page < end) {
    if (vm_page_in_area(proc, page) != 0) {
      unmap_page(proc_table[proc].vm.ptbr, page);
    }
    page = page + 4096;
  }
  i = 0;
  while (i < CFG_MAX_VMAS) {
    if (proc_table[proc].vm.areas[i].used != 0 &&
        start > proc_table[proc].vm.areas[i].start &&
        end < proc_table[proc].vm.areas[i].end) {
      split = vm_area_slot(proc);
      vm_area_assign(proc, split, end, proc_table[proc].vm.areas[i].end,
        proc_table[proc].vm.areas[i].prot,
        proc_table[proc].vm.areas[i].flags);
      proc_table[proc].vm.areas[i].end = start;
    } else if (proc_table[proc].vm.areas[i].used != 0 &&
        start <= proc_table[proc].vm.areas[i].start &&
        end >= proc_table[proc].vm.areas[i].end) {
      proc_table[proc].vm.areas[i].used = 0;
    } else if (proc_table[proc].vm.areas[i].used != 0 &&
        start <= proc_table[proc].vm.areas[i].start &&
        end > proc_table[proc].vm.areas[i].start) {
      proc_table[proc].vm.areas[i].start = end;
    } else if (proc_table[proc].vm.areas[i].used != 0 &&
        start < proc_table[proc].vm.areas[i].end &&
        end >= proc_table[proc].vm.areas[i].end) {
      proc_table[proc].vm.areas[i].end = start;
    }
    i = i + 1;
  }
  return 0;
}

int vm_mprotect_slots_needed(int proc, int start, int end) {
  int i;
  int needed;
  int overlap_start;
  int overlap_end;
  needed = 0;
  i = 0;
  while (i < CFG_MAX_VMAS) {
    if (proc_table[proc].vm.areas[i].used != 0 &&
        start < proc_table[proc].vm.areas[i].end &&
        end > proc_table[proc].vm.areas[i].start) {
      overlap_start = start;
      if (overlap_start < proc_table[proc].vm.areas[i].start) {
        overlap_start = proc_table[proc].vm.areas[i].start;
      }
      overlap_end = end;
      if (overlap_end > proc_table[proc].vm.areas[i].end) {
        overlap_end = proc_table[proc].vm.areas[i].end;
      }
      if (overlap_start > proc_table[proc].vm.areas[i].start) {
        needed = needed + 1;
      }
      if (overlap_end < proc_table[proc].vm.areas[i].end) {
        needed = needed + 1;
      }
    }
    i = i + 1;
  }
  return needed;
}

int vm_free_area_slots(int proc) {
  int i;
  int count;
  count = 0;
  i = 0;
  while (i < CFG_MAX_VMAS) {
    if (proc_table[proc].vm.areas[i].used == 0) count = count + 1;
    i = i + 1;
  }
  return count;
}

void vm_mprotect_areas(int proc, int start, int end, int prot) {
  int i;
  int slot;
  int right;
  int area_start;
  int area_end;
  int overlap_start;
  int overlap_end;
  int old_prot;
  int old_flags;
  int original[CFG_MAX_VMAS];
  i = 0;
  while (i < CFG_MAX_VMAS) {
    original[i] = proc_table[proc].vm.areas[i].used;
    i = i + 1;
  }
  i = 0;
  while (i < CFG_MAX_VMAS) {
    if (original[i] != 0 &&
        start < proc_table[proc].vm.areas[i].end &&
        end > proc_table[proc].vm.areas[i].start) {
      area_start = proc_table[proc].vm.areas[i].start;
      area_end = proc_table[proc].vm.areas[i].end;
      old_prot = proc_table[proc].vm.areas[i].prot;
      old_flags = proc_table[proc].vm.areas[i].flags;
      overlap_start = start;
      if (overlap_start < area_start) overlap_start = area_start;
      overlap_end = end;
      if (overlap_end > area_end) overlap_end = area_end;
      if (overlap_start == area_start && overlap_end == area_end) {
        proc_table[proc].vm.areas[i].prot = prot;
      } else if (overlap_start == area_start) {
        proc_table[proc].vm.areas[i].start = overlap_end;
        slot = vm_area_slot(proc);
        vm_area_assign(proc, slot, area_start, overlap_end, prot, old_flags);
      } else if (overlap_end == area_end) {
        proc_table[proc].vm.areas[i].end = overlap_start;
        slot = vm_area_slot(proc);
        vm_area_assign(proc, slot, overlap_start, area_end, prot, old_flags);
      } else {
        proc_table[proc].vm.areas[i].end = overlap_start;
        slot = vm_area_slot(proc);
        vm_area_assign(proc, slot, overlap_start, overlap_end, prot, old_flags);
        right = vm_area_slot(proc);
        vm_area_assign(proc, right, overlap_end, area_end, old_prot, old_flags);
      }
    }
    i = i + 1;
  }
}

int vm_mprotect(int proc, int address, int length, int prot) {
  int start;
  int end;
  int page;
  int *pd;
  int pde;
  int *pt;
  int pte;
  int flags;
  if ((address & 4095) != 0 || length <= 0 ||
      (prot & ~(CFG_PROT_READ | CFG_PROT_WRITE | CFG_PROT_EXEC)) != 0) {
    return -CFG_EINVAL;
  }
  start = address;
  end = address + page_align_up(length);
  if (start < CFG_USER_BASE || end < start || end > CFG_USER_STACK_TOP ||
      vm_range_mapped(proc, start, end) == 0) {
    return -CFG_ENOMEM;
  }
  if (vm_mprotect_slots_needed(proc, start, end) > vm_free_area_slots(proc)) {
    return -CFG_ENOMEM;
  }
  pd = proc_table[proc].vm.ptbr;
  page = start;
  while (page < end) {
    pde = pd[(page >> 22) & 0x3ff];
    pt = pde & 0xfffff000;
    pte = pt[(page >> 12) & 0x3ff];
    flags = 1;
    if (prot != CFG_PROT_NONE) {
      flags = flags | 4;
    }
    if ((prot & CFG_PROT_WRITE) != 0) {
      flags = flags | 2;
    }
    pt[(page >> 12) & 0x3ff] = (pte & 0xfffff000) | flags;
    page = page + 4096;
  }
  vm_mprotect_areas(proc, start, end, prot);
  return 0;
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
