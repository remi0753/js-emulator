// Executable loading and argv setup: copy paths/arguments in from user memory,
// load a flat executable image into a fresh address space, lay out argv on the
// user stack, and rebuild a caller's address space for exec.
#include "kernel.h"

char kpath[CFG_INITPATH_LEN]; // a path copied in from user memory
char exec_hdr[12];            // the executable header (magic, entry, memSize)
char argbuf[CFG_ARGBUF_LEN];  // packed NUL-terminated argv strings
int arg_off[CFG_MAXARG];      // start offset of each arg in argbuf
int g_argc;                   // argument count staged for the next spawn

// Copy a NUL-terminated path from user memory into the kpath kernel buffer.
int copy_path_in(int proc, int upath) {
  if (copyinstr(proc, kpath, upath, CFG_INITPATH_LEN) < 0) {
    return -1;
  }
  return 0;
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
  int len;
  argc = 0;
  total = 0;
  if (uargv != 0) {
    while (argc < CFG_MAXARG) {
      if (copyin(proc, &ptr, uargv + argc * 4, 4) < 0) {
        return -1;
      }
      if (ptr == 0) {
        break;
      }
      arg_off[argc] = total;
      len = copyinstr(proc, argbuf + total, ptr, CFG_ARGBUF_LEN - total);
      if (len < 0) {
        return -1;
      }
      total = total + len + 1; // advance past the copied string and its NUL
      argc = argc + 1;
    }
    // Reject argv arrays longer than MAXARG (the slot after the last must be 0).
    if (argc == CFG_MAXARG) {
      if (copyin(proc, &ptr, uargv + argc * 4, 4) < 0) {
        return -1;
      }
      if (ptr != 0) {
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

int do_exec(int idx, int upath, int uargv) {
  int old_pd;
  if (copy_path_in(idx, upath) < 0) {
    proc_regs[idx * 8 + 0] = -CFG_EFAULT;
    return 0;
  }
  if (build_args_from_user(idx, uargv) < 0) {
    proc_regs[idx * 8 + 0] = -CFG_EFAULT;
    return 0;
  }
  old_pd = proc_ptbr[idx];
  if (spawn(idx, kpath) < 0) {
    proc_regs[idx * 8 + 0] = -CFG_ENOEXEC;
    return 0;
  }
  return old_pd;
}
