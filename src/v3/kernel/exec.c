// Executable loading and argv setup: copy paths/arguments in from user memory,
// load a flat executable image into a fresh address space, lay out argv on the
// user stack, and rebuild a caller's address space for exec.
#include "kernel.h"

char kpath[CFG_INITPATH_LEN]; // a path copied in from user memory
char exec_hdr[12];            // the executable header (magic, entry, memSize)
char argbuf[CFG_ARGBUF_LEN];  // packed NUL-terminated argv strings
int arg_off[CFG_MAXARG];      // start offset of each arg in argbuf
int g_argc;                   // argument count staged for the next spawn
int g_exec_image_end;

// Copy a NUL-terminated path from user memory into the kpath kernel buffer.
int copy_path_in(int proc, int upath) {
  return copyinstr(proc, kpath, upath, CFG_INITPATH_LEN);
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
        return -CFG_EFAULT;
      }
      if (ptr == 0) {
        break;
      }
      arg_off[argc] = total;
      len = copyinstr(proc, argbuf + total, ptr, CFG_ARGBUF_LEN - total);
      if (len < 0) {
        return len;
      }
      total = total + len + 1; // advance past the copied string and its NUL
      argc = argc + 1;
    }
    // Reject argv arrays longer than MAXARG (the slot after the last must be 0).
    if (argc == CFG_MAXARG) {
      if (copyin(proc, &ptr, uargv + argc * 4, 4) < 0) {
        return -CFG_EFAULT;
      }
      if (ptr != 0) {
        return -CFG_E2BIG;
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
  struct vnode node;
  int result;
  int entry;
  int memsz;
  int npages;
  int i;
  int frame;
  result = vfs_lookup(path, 1, current, &node);
  if (result < 0) return result;
  if (node.inode.type != CFG_T_FILE) {
    return -CFG_ENOEXEC;
  }
  if (node.inode.size < 12 ||
      vnode_read(&node, current, 0, 12, exec_hdr) != 12) {
    return -CFG_ENOEXEC;
  }
  if (read32_at(exec_hdr) != CFG_EXEC_MAGIC) {
    return -CFG_ENOEXEC;
  }
  entry = read32_at(exec_hdr + 4);
  memsz = read32_at(exec_hdr + 8);
  if (memsz <= 0 || memsz > CFG_USER_STACK_PAGE - CFG_USER_LOAD_BASE) {
    return -CFG_ENOEXEC;
  }
  if (node.inode.size - 12 > memsz) {
    return -CFG_ENOEXEC;
  }
  if (entry < CFG_USER_LOAD_BASE || entry >= CFG_USER_LOAD_BASE + memsz) {
    return -CFG_ENOEXEC;
  }
  npages = (memsz + 4095) / 4096;
  g_exec_image_end = CFG_USER_LOAD_BASE + npages * 4096;
  if (npages + 2 > free_frame_count()) {
    return -CFG_ENOMEM;
  }
  i = 0;
  while (i < npages) {
    frame = alloc_frame();
    zero_page(frame);
    // file bytes after the 12-byte header map to USER_LOAD_BASE upward
    vnode_read(&node, current, 12 + i * 4096, 4096, frame);
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
    return -CFG_E2BIG;
  }
  i = 0;
  while (i < g_argc) {
    avaddr = strbase + arg_off[i];
    write32_at(sframe + (argvaddr - CFG_USER_STACK_PAGE) + i * 4, avaddr);
    i = i + 1;
  }
  write32_at(sframe + (argvaddr - CFG_USER_STACK_PAGE) + g_argc * 4, 0);

  proc_table[idx].ctx.regs[0] = g_argc; // R0 = argc
  proc_table[idx].ctx.regs[1] = argvaddr; // R1 = argv
  i = 2;
  while (i < 8) {
    proc_table[idx].ctx.regs[i] = 0;
    i = i + 1;
  }
  proc_table[idx].ctx.sp = argvaddr; // hardware stack grows down, below the args
  return 0;
}

// Build a new address space for slot idx running the program at `path` (a kernel
// address) with the argv currently staged in argbuf. Does not touch fds.
int spawn(int idx, int path) {
  int pd;
  int entry;
  int result;
  if (free_list == 0) {
    return -CFG_ENOMEM;
  }
  pd = new_address_space();
  entry = load_exec_image(pd, path);
  if (entry < 0) {
    free_space(pd);
    return entry;
  }
  result = setup_user_args(idx, pd);
  if (result < 0) {
    free_space(pd);
    return result;
  }
  vm_init(idx, pd, g_exec_image_end);
  proc_table[idx].ctx.pc = entry;
  proc_table[idx].ctx.mode = CFG_MODE_USER;
  proc_table[idx].ctx.flags = CFG_FLAG_IF;
  return 0;
}

int do_exec(int idx, int upath, int uargv) {
  int result;
  int old_pd;
  result = copy_path_in(idx, upath);
  if (result < 0) {
    proc_table[idx].ctx.regs[0] = result;
    return 0;
  }
  result = build_args_from_user(idx, uargv);
  if (result < 0) {
    proc_table[idx].ctx.regs[0] = result;
    return 0;
  }
  old_pd = proc_table[idx].vm.ptbr;
  result = spawn(idx, kpath);
  if (result < 0) {
    proc_table[idx].ctx.regs[0] = result;
    return 0;
  }
  signal_exec_proc(idx);
  close_exec_fds(idx);
  return old_pd;
}
