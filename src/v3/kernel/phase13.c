// Phase 13: syscalls + process lifecycle inside the guest.
//
// Builds on the Phase 12 guest kernel (free-list PMM, per-process address
// spaces, fork-by-copy, user-mode entry, timer-driven round-robin). The new
// work is a full syscall ABI handled entirely in guest code: the CPU only ever
// delivers INT 0x80; this kernel decodes the registers, reads user memory,
// updates process state, and returns with IRET. It implements exit, write,
// read, yield, getpid, fork, exec, and wait, with a real process lifecycle
// (runnable / zombie / blocked) so a user program can fork a child, the child
// can exec a different image and print, and the parent can wait for it -- all
// with no TypeScript syscall dispatch.
//
// CFG_* tokens are substituted with numeric literals by the loader in
// ../guest-kernel.ts (the single source of truth for the memory layout, ISA
// constants, and syscall numbers); CFG_PROG0_BYTES / CFG_PROG1_BYTES are the
// two assembled user programs injected as char-array initializers.

int ticks;
int current;
int nproc;
int free_list;
int kernel_pt;
int page_fault_addr;

// Per-process state, stored as flat arrays so the assembly trap stub can also
// reach the live trap registers through fixed global labels (sctx_*).
int proc_state[CFG_MAX_PROC]; // unused / runnable / zombie / blocked
int proc_parent[CFG_MAX_PROC]; // parent slot, -1 for the initial process
int proc_exit_code[CFG_MAX_PROC];
int proc_ptbr[CFG_MAX_PROC];
int proc_regs[CFG_PROC_REG_COUNT]; // proc * 8 + register number
int proc_pc[CFG_MAX_PROC];
int proc_sp[CFG_MAX_PROC];
int proc_flags[CFG_MAX_PROC];
int proc_mode[CFG_MAX_PROC];
int proc_data_frame[CFG_MAX_PROC]; // physical frame backing each process's user data page

// Trap-frame scratch shared with the assembly trap/context-switch stubs.
int sctx_r0; int sctx_r1; int sctx_r2; int sctx_r3;
int sctx_r4; int sctx_r5; int sctx_r6; int sctx_r7;
int sctx_pc; int sctx_sp; int sctx_flags; int sctx_mode;

// Captured addresses of the assembly trap stubs (filled by capture_handlers()).
int default_handler_addr;
int timer_handler_addr;
int pf_handler_addr;
int syscall_handler_addr;

// The two user images: prog0 is the init process loaded at boot; prog1 is the
// child image that init's forked child execs into.
char prog0[CFG_PROG0_LEN] = CFG_PROG0_BYTES;
char prog1[CFG_PROG1_LEN] = CFG_PROG1_BYTES;

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
  serial_write("phase13: PANIC: ");
  serial_write(msg);
  serial_putc('\n');
  __di();
  __halt();
}

void zero_page(int addr) {
  memset(addr, 0, 4096);
}

void copy_page(int src, int dst) {
  memcpy(dst, src, 4096);
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

void pmm_init() {
  int f;
  free_list = 0;
  // Free high to low so the list hands out the lowest frame first (deterministic).
  f = CFG_FRAME_POOL_END - 4096;
  while (f >= CFG_FRAME_POOL_BASE) {
    free_frame(f);
    f = f - 4096;
  }
}

// --- virtual memory ---

// Identity-map the low 4 MiB into the shared kernel page table. Every address
// space points its page-directory entry 0 at this table, so kernel code, data,
// stacks, and the frame pool keep the same addresses in every process.
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

// Map one page into pd, allocating a page table on demand.
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
    pde = pt | CFG_PTE_USER; // permissive PDE; the PTE enforces real permissions
    pdp[(vaddr >> 22) & 0x3ff] = pde;
  }
  ptp = pde & 0xfffff000;
  ptp[(vaddr >> 12) & 0x3ff] = (frame & 0xfffff000) | flags | 1;
}

// Walk pd and return the physical frame backing vaddr (assumes it is mapped).
int get_phys(int pd, int vaddr) {
  int *pdp;
  int pde;
  int *ptp;
  pdp = pd;
  pde = pdp[(vaddr >> 22) & 0x3ff];
  ptp = pde & 0xfffff000;
  return ptp[(vaddr >> 12) & 0x3ff] & 0xfffff000;
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
    if ((pte & 5) != 5 || (write != 0 && (pte & 2) == 0)) {
      return 0;
    }
    page = page + 4096;
  }
  return 1;
}

// Copy every user mapping (page-directory entries 1..1023) from src to dst,
// duplicating each frame's contents. This is fork without copy-on-write.
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

// Free every user mapping (entries 1..1023): the mapped frames, the page
// tables, and finally the page directory. Entry 0 (the shared kernel page
// table) is left untouched. The caller must ensure pd is not the live address
// space when this runs (the syscall path frees only after switching ptbr).
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

// --- processes ---

void set_initial_context(int idx, int tag) {
  int i;
  i = 0;
  while (i < 8) {
    proc_regs[idx * 8 + i] = 0;
    i = i + 1;
  }
  proc_regs[idx * 8 + 0] = tag; // R0 = tag, read by the user program at entry
  proc_pc[idx] = CFG_USER_CODE;
  proc_sp[idx] = CFG_USER_STACK_TOP;
  proc_mode[idx] = CFG_MODE_USER;
  proc_flags[idx] = CFG_FLAG_IF; // interrupts enabled so the timer can preempt
}

// Find a free PCB slot, extending nproc only when no exited slot can be reused.
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

void load_user_image(int code, int id) {
  if (id == 0) {
    memcpy(code, prog0, CFG_PROG0_LEN);
  } else if (id == 1) {
    memcpy(code, prog1, CFG_PROG1_LEN);
  } else {
    panic("exec: bad program id");
  }
}

// Build a fresh address space for slot idx running program `id`, with R0 seeded
// to `tag`. Sets proc_ptbr / proc_data_frame and resets the process context.
void build_image(int idx, int id, int tag) {
  int pd;
  int code;
  int data;
  int stack;
  pd = new_address_space();
  code = alloc_frame();
  data = alloc_frame();
  stack = alloc_frame();
  zero_page(data);
  zero_page(stack);
  load_user_image(code, id);
  map_page(pd, CFG_USER_CODE, code, CFG_PTE_USER);
  map_page(pd, CFG_USER_DATA, data, CFG_PTE_USER);
  map_page(pd, CFG_USER_STACK_PAGE, stack, CFG_PTE_USER);
  proc_ptbr[idx] = pd;
  proc_data_frame[idx] = data;
  set_initial_context(idx, tag);
}

int setup_process(int id, int tag) {
  int idx;
  idx = alloc_proc();
  build_image(idx, id, tag);
  proc_parent[idx] = -1;
  proc_state[idx] = CFG_ST_RUNNABLE;
  return idx;
}

// Duplicate an existing process into a fresh, isolated address space (fork).
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
  proc_data_frame[idx] = get_phys(pd, CFG_USER_DATA);
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

// Round-robin the next runnable slot after `current`; -1 if none is runnable.
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

// Pick the next runnable process; if every process has finished, halt the VM.
void switch_to_next() {
  int next;
  next = schedule();
  if (next < 0) {
    serial_write("phase13: all processes exited\n");
    __halt();
  }
  current = next;
}

// Timer IRQ: spill the interrupted process (already in sctx_*), round-robin to
// the next runnable process, reload it, and switch the live page directory.
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

// Copy `len` bytes from a user virtual address out to the console. The syscall
// runs with the calling process's page directory still live, so user pointers
// are directly readable; we only bound-check them to the user address range.
int sys_write(int caller, int fd, int buf, int len) {
  char *p;
  int i;
  if (fd != 1 && fd != 2) {
    return -1;
  }
  if (len < 0) {
    return -1;
  }
  if (user_access_ok(caller, buf, len, 0) == 0) {
    return -1;
  }
  p = buf;
  i = 0;
  while (i < len) {
    serial_putc(p[i]);
    i = i + 1;
  }
  return len;
}

// Read at most one byte from the keyboard into a user buffer; 0 means no input
// is available (treated as EOF by callers). No blocking yet.
int sys_read(int caller, int fd, int buf, int len) {
  char *p;
  int ch;
  if (fd != 0) {
    return -1;
  }
  if (len <= 0) {
    return 0;
  }
  if (user_access_ok(caller, buf, len, 1) == 0) {
    return -1;
  }
  ch = __in(CFG_KBD_DATA);
  if (ch == 0) {
    return 0;
  }
  p = buf;
  p[0] = ch;
  return 1;
}

// fork: child gets its own copy of the address space and sees a return of 0;
// the parent sees the child's pid.
int do_fork(int parent) {
  int idx;
  idx = fork_process(parent);
  proc_parent[idx] = parent;
  proc_state[idx] = CFG_ST_RUNNABLE;
  proc_regs[idx * 8 + 0] = 0;
  return idx;
}

// exec: replace the caller's image with program `id` in a fresh address space.
// Returns the caller's old page directory so the syscall path can free it after
// switching ptbr; on success there is no return to the caller (build_image
// resets pc to the new entry and R0 to 0).
int do_exec(int idx, int id) {
  int old_pd;
  if (id < 0 || id > 1) {
    proc_regs[idx * 8 + 0] = -1;
    return 0;
  }
  old_pd = proc_ptbr[idx];
  build_image(idx, id, 0);
  return old_pd;
}

// exit: become a zombie holding the exit code. If a parent is already blocked
// in wait, complete its wait now (it reaps this child) and hand back the
// child's page directory to free; otherwise stay a zombie until waited.
int do_exit(int idx, int code) {
  int p;
  proc_exit_code[idx] = code;
  proc_state[idx] = CFG_ST_ZOMBIE;
  p = proc_parent[idx];
  if (p >= 0 && proc_state[p] == CFG_ST_BLOCKED) {
    proc_regs[p * 8 + 0] = idx; // the parent's wait() returns this child's pid
    proc_state[p] = CFG_ST_RUNNABLE;
    proc_state[idx] = CFG_ST_UNUSED; // reaped by the waking parent
    return proc_ptbr[idx];
  }
  return 0;
}

// wait: reap a zombie child if one exists (returning its pid); otherwise block
// until a child exits (do_exit wakes us), or return -1 if there are no children.
// Returns the page directory of any reaped child to free, else 0. Sets the
// caller's R0 unless it blocks (do_exit sets it on wake).
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
    proc_regs[parent * 8 + 0] = -1; // no children to wait for
    return 0;
  }
  proc_state[parent] = CFG_ST_BLOCKED;
  switch_to_next();
  return 0;
}

// Called by the syscall stub with the caller's registers + trap frame spilled
// into sctx_*. Decode R0 (number) / R1..R3 (args), dispatch, set the caller's
// R0 return value, possibly switch the current process, then reload context and
// page directory; the stub IRETs into whatever process is current afterwards.
void on_syscall() {
  int caller;
  int num;
  int a1;
  int a2;
  int a3;
  int pending_free;
  if (sctx_mode != CFG_MODE_USER) {
    panic("syscall outside user");
  }
  pending_free = 0;
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
    proc_regs[caller * 8 + 0] = sys_write(caller, a1, a2, a3);
  } else if (num == CFG_SYS_READ) {
    proc_regs[caller * 8 + 0] = sys_read(caller, a1, a2, a3);
  } else if (num == CFG_SYS_YIELD) {
    proc_regs[caller * 8 + 0] = 0;
    switch_to_next();
  } else if (num == CFG_SYS_GETPID) {
    proc_regs[caller * 8 + 0] = caller;
  } else if (num == CFG_SYS_FORK) {
    proc_regs[caller * 8 + 0] = do_fork(caller);
  } else if (num == CFG_SYS_EXEC) {
    pending_free = do_exec(caller, a1);
  } else if (num == CFG_SYS_WAIT) {
    pending_free = do_wait(caller);
  } else {
    proc_regs[caller * 8 + 0] = -1;
  }

  load_ctx(current);
  __lptbr(proc_ptbr[current]);
  // Frees happen only after the ptbr switch above, so we never free the page
  // directory the CPU is currently translating through (exec frees the old
  // image; exit/wait free a reaped child -- all distinct from `current`).
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
    MOV R1, phase13_default_handler
    STORE R1, default_handler_addr
    MOV R1, phase13_timer_handler
    STORE R1, timer_handler_addr
    MOV R1, phase13_pf_handler
    STORE R1, pf_handler_addr
    MOV R1, phase13_syscall_handler
    STORE R1, syscall_handler_addr
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
  set_user_idt_entry(CFG_SYSCALL_VECTOR, syscall_handler_addr);
  __lksp(CFG_KSTACK_TOP);
}

int kmain() {
  asm("
    JMP phase13_handlers_done

  phase13_timer_handler:
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
    JMP phase13_resume

  phase13_syscall_handler:
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

  phase13_resume:
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

  phase13_pf_handler:
    CALL on_page_fault

  phase13_default_handler:
    CALL on_default_trap

  phase13_handlers_done:
  ");

  serial_write("phase13: boot\n");
  setup_traps();
  pmm_init();
  build_kernel_pt();

  // The init process (program 0). It forks a child that execs program 1.
  setup_process(0, 0);

  __stmr(CFG_TIMER_PERIOD);
  current = 0;
  __lptbr(proc_ptbr[0]);
  __pgon();
  load_ctx(0);
  serial_write("phase13: enter user\n");

  // Hand the CPU to init; from here the kernel only runs inside trap handlers
  // (the timer and INT 0x80), driving the whole process lifecycle in guest code.
  asm("JMP phase13_resume");
  return 0;
}
