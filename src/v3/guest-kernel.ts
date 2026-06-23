import { assemble } from '../assembler.ts';
import { FLAG, IDT_ENTRY_SIZE, IDT_PRESENT, TIMER_IRQ, TRAP } from '../isa.ts';
import { compileC } from '../toolchain/c.ts';
import { type KernelImage, linkKernelImage } from '../toolchain/linker.ts';
import { PORT } from '../vm/custom32/platform.ts';

// Fixed physical addresses the Phase 11 kernel owns. Everything here lives inside
// the identity-mapped low region (0..512 KiB, see setup_paging) so the kernel can
// touch its own structures whether or not paging is on. The frame pool sits above
// the kernel image / IDT / page tables and below the hardware stack.
export const PHASE11_KERNEL_LAYOUT = {
  idt: 0x8000,
  pageDirectory: 0x10000,
  pageTable0: 0x11000,
  framePoolBase: 0x20000, // bump frame allocator: first frame handed out
  framePoolEnd: 0x40000, // one past the last usable frame
  demandVirtual: 0x90000, // a virtual page deliberately left unmapped (outside identity)
  stackTop: 0x70000,
} as const;

const TIMER_VECTOR = TRAP.IRQ_BASE + TIMER_IRQ;

export const PHASE11_GUEST_KERNEL_SOURCE = String.raw`
int ticks;
int pf_count;
int page_fault_addr;
int page_fault_err;
int deliberate_value;
int idle_count;

int next_frame = ${PHASE11_KERNEL_LAYOUT.framePoolBase};

// Captured addresses of the assembly trap stubs, filled by capture_handlers().
int default_handler_addr;
int timer_handler_addr;
int pf_handler_addr;

void serial_putc(int ch) {
  __out(${PORT.CONSOLE_DATA}, ch);
}

void serial_write(char *s) {
  int i;
  i = 0;
  while (s[i] != 0) {
    serial_putc(s[i]);
    i = i + 1;
  }
}

// Fatal stop: report on the serial console, mask interrupts, and halt the CPU.
void panic(char *msg) {
  serial_write("phase11: PANIC: ");
  serial_write(msg);
  serial_putc('\n');
  __di();
  __halt();
}

// Bump physical-frame allocator over [framePoolBase, framePoolEnd).
int alloc_frame() {
  int frame;
  if (next_frame >= ${PHASE11_KERNEL_LAYOUT.framePoolEnd}) {
    panic("out of physical frames");
  }
  frame = next_frame;
  next_frame = next_frame + 4096;
  return frame;
}

// Install one IDT gate: [+0] handler address, [+4] flags.
void set_idt_entry(int vector, int handler) {
  int *entry;
  entry = ${PHASE11_KERNEL_LAYOUT.idt} + vector * ${IDT_ENTRY_SIZE};
  entry[0] = handler;
  entry[1] = ${IDT_PRESENT};
}

// Map one 4 KiB page in the single page table the kernel builds. Phase 11 only
// uses page-directory entry 0 (the low 4 MiB); anything else is a kernel bug.
void map_page(int vaddr, int frame) {
  int *pt;
  int index;
  if ((vaddr >> 22) != 0) {
    panic("page fault outside the mapped region");
  }
  index = (vaddr >> 12) & 0x3ff;
  pt = ${PHASE11_KERNEL_LAYOUT.pageTable0};
  pt[index] = frame | 3;
}

void capture_handlers() {
  asm("
    MOV R1, phase11_default_handler
    STORE R1, default_handler_addr
    MOV R1, phase11_timer_handler
    STORE R1, timer_handler_addr
    MOV R1, phase11_pf_handler
    STORE R1, pf_handler_addr
  ");
}

void setup_traps() {
  int v;

  capture_handlers();
  __lidt(${PHASE11_KERNEL_LAYOUT.idt});

  // Own every vector: an unexpected trap reaches the guest and panics rather
  // than silently falling back to the host.
  v = 0;
  while (v < 256) {
    set_idt_entry(v, default_handler_addr);
    v = v + 1;
  }
  set_idt_entry(${TIMER_VECTOR}, timer_handler_addr);
  set_idt_entry(${TRAP.PAGEFAULT}, pf_handler_addr);

  __lksp(${PHASE11_KERNEL_LAYOUT.stackTop});
}

void setup_paging() {
  int *pd;
  int *pt;
  int i;

  pd = ${PHASE11_KERNEL_LAYOUT.pageDirectory};
  pt = ${PHASE11_KERNEL_LAYOUT.pageTable0};

  i = 0;
  while (i < 1024) {
    pd[i] = 0;
    pt[i] = 0;
    i = i + 1;
  }

  // Identity-map the low 512 KiB so kernel code, data, stack, and structures
  // keep the same addresses once paging is on.
  i = 0;
  while (i < 128) {
    pt[i] = (i * 4096) | 3;
    i = i + 1;
  }
  pd[0] = ${PHASE11_KERNEL_LAYOUT.pageTable0} | 3;

  __lptbr(${PHASE11_KERNEL_LAYOUT.pageDirectory});
  __pgon();
}

// Called from the page-fault stub: allocate a frame and map the faulting page,
// then the CPU retries the faulting access transparently.
void handle_page_fault() {
  int vaddr;
  int frame;
  vaddr = __rdpfla();
  page_fault_addr = vaddr;
  page_fault_err = __rderr();
  frame = alloc_frame();
  map_page(vaddr, frame);
  pf_count = pf_count + 1;
}

void timer_tick() {
  ticks = ticks + 1;
}

void default_trap() {
  panic("unexpected trap");
}

void trigger_page_fault() {
  int *faulting;
  faulting = ${PHASE11_KERNEL_LAYOUT.demandVirtual};
  // Touch an unmapped page: the fault handler allocates a frame and maps it,
  // then this write (and the read-back below) complete on the retried access.
  *faulting = 0x51;
  deliberate_value = *faulting;
}

int kmain() {
  asm("
    JMP phase11_handlers_done

  phase11_timer_handler:
    PUSH R0
    PUSH R1
    PUSH R2
    PUSH R3
    PUSH R4
    PUSH R5
    PUSH R7
    CALL timer_tick
    POP R7
    POP R5
    POP R4
    POP R3
    POP R2
    POP R1
    POP R0
    IRET

  phase11_pf_handler:
    PUSH R0
    PUSH R1
    PUSH R2
    PUSH R3
    PUSH R4
    PUSH R5
    PUSH R7
    CALL handle_page_fault
    POP R7
    POP R5
    POP R4
    POP R3
    POP R2
    POP R1
    POP R0
    IRET

  phase11_default_handler:
    CALL default_trap

  phase11_handlers_done:
  ");

  serial_write("phase11: boot\n");
  setup_traps();
  setup_paging();
  serial_write("phase11: paging\n");
  trigger_page_fault();
  serial_write("phase11: pf\n");
  __stmr(40);
  __ei();
  serial_write("phase11: idle\n");

  while (1) {
    idle_count = idle_count + 1;
  }

  return 0;
}
`;

export function buildPhase11KernelImage(): KernelImage {
  return linkKernelImage([
    compileC(PHASE11_GUEST_KERNEL_SOURCE, {
      start: 'kernel',
      cStackSize: 8192,
      moduleId: 'phase11',
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Phase 12: memory management + scheduling inside the guest.
//
// The kernel owns a free-list physical frame allocator, builds a per-process
// virtual address space (its own page directory + user page table sharing one
// identity-mapped kernel page table), creates user processes, enters user mode
// via IRET, and round-robin context-switches between them on the in-CPU timer
// IRQ. `fork` duplicates an address space by copying frames (no COW yet).
// TypeScript only sees opaque physical memory: it never touches process state.
// ---------------------------------------------------------------------------

const PTE_KERNEL = 3; // present + writable (no user bit): kernel-only page
const PTE_USER = 7; // present + writable + user-accessible: user page

export const PHASE12_KERNEL_LAYOUT = {
  // Kernel structures, all inside the identity-mapped low region (0..4 MiB) so
  // the kernel keeps the same addresses no matter which page directory is live.
  idt: 0x40000,
  kernelPageTable: 0x41000, // identity-maps the low 4 MiB; shared by every address space
  kstackTop: 0x50000, // hardware kernel stack (esp0) used on USER->KERNEL traps
  framePoolBase: 0x100000, // free-list frame allocator: first usable frame
  framePoolEnd: 0x380000, // one past the last usable frame
  // Per-process user virtual layout (page-directory entry 1, the 4..8 MiB range).
  userCode: 0x400000,
  userData: 0x401000,
  userStackPage: 0x40f000,
  userStackTop: 0x410000,
  // Boot/run knobs. The period must comfortably exceed the cost of one trip
  // through the timer handler (save/switch/restore, a few hundred instructions);
  // otherwise the next IRQ is already pending on IRET and the user never runs.
  timerPeriod: 8000, // in-CPU timer IRQ every N instructions
  physSize: 0x400000, // 4 MiB of physical RAM (covers the identity map + pool)
} as const;

const PHASE12_TIMER_VECTOR = TRAP.IRQ_BASE + TIMER_IRQ;

// The user program every process runs: bump a counter and stamp its fork tag,
// both at fixed user virtual addresses, forever. Two processes touching the
// same virtual addresses but landing in different physical frames proves the
// address spaces are isolated; both counters advancing proves both were
// scheduled by the timer. R0 holds the per-process tag at entry (the kernel
// seeds it like a fork return value).
const PHASE12_USER_PROGRAM = `
  MOVR R2, R0            ; R2 = tag (seeded by the kernel in the initial context)
  MOV R3, 0              ; R3 = loop counter
uloop:
  INC R3
  STORE R3, ${PHASE12_KERNEL_LAYOUT.userData}
  STORE R2, ${PHASE12_KERNEL_LAYOUT.userData + 4}
  JMP uloop
`;

function phase12Source(): string {
  const userBytes = assemble(PHASE12_USER_PROGRAM, PHASE12_KERNEL_LAYOUT.userCode).bytes;
  const userInit = Array.from(userBytes).join(', ');
  const L = PHASE12_KERNEL_LAYOUT;

  return String.raw`
int ticks;
int current;
int nproc;
int free_list;
int kernel_pt;
int page_fault_addr;

// Per-process state, stored as flat arrays so the assembly trap stub can also
// reach the live trap registers through fixed global labels (sctx_*).
int proc_used[8];
int proc_ptbr[8];
int proc_regs[64]; // proc * 8 + register number
int proc_pc[8];
int proc_sp[8];
int proc_flags[8];
int proc_mode[8];
int proc_data_frame[8]; // physical frame backing each process's user data page

// Trap-frame scratch shared with the assembly context-switch stub.
int sctx_r0; int sctx_r1; int sctx_r2; int sctx_r3;
int sctx_r4; int sctx_r5; int sctx_r6; int sctx_r7;
int sctx_pc; int sctx_sp; int sctx_flags; int sctx_mode;

// Captured addresses of the assembly trap stubs (filled by capture_handlers()).
int default_handler_addr;
int timer_handler_addr;
int pf_handler_addr;

char user_program[${userBytes.length}] = {${userInit}};

void serial_putc(int ch) {
  __out(${PORT.CONSOLE_DATA}, ch);
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
  serial_write("phase12: PANIC: ");
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
  f = ${L.framePoolEnd} - 4096;
  while (f >= ${L.framePoolBase}) {
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
  pt = ${L.kernelPageTable};
  i = 0;
  while (i < 1024) {
    pt[i] = (i * 4096) | ${PTE_KERNEL};
    i = i + 1;
  }
  kernel_pt = ${L.kernelPageTable};
}

int new_address_space() {
  int pd;
  int *p;
  pd = alloc_frame();
  zero_page(pd);
  p = pd;
  p[0] = kernel_pt | ${PTE_KERNEL}; // share the kernel identity map
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
    pde = pt | ${PTE_USER}; // permissive PDE; the PTE enforces real permissions
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

// --- processes ---

void set_initial_context(int idx, int tag) {
  int i;
  i = 0;
  while (i < 8) {
    proc_regs[idx * 8 + i] = 0;
    i = i + 1;
  }
  proc_regs[idx * 8 + 0] = tag; // R0 = tag, read by the user program at entry
  proc_pc[idx] = ${L.userCode};
  proc_sp[idx] = ${L.userStackTop};
  proc_mode[idx] = 1;            // USER
  proc_flags[idx] = ${FLAG.IF};  // interrupts enabled so the timer can preempt
}

int setup_process(int tag) {
  int idx;
  int pd;
  int code;
  int data;
  int stack;
  idx = nproc;
  nproc = nproc + 1;
  pd = new_address_space();
  code = alloc_frame();
  data = alloc_frame();
  stack = alloc_frame();
  zero_page(data);
  zero_page(stack);
  memcpy(code, user_program, ${userBytes.length});
  map_page(pd, ${L.userCode}, code, ${PTE_USER});
  map_page(pd, ${L.userData}, data, ${PTE_USER});
  map_page(pd, ${L.userStackPage}, stack, ${PTE_USER});
  proc_ptbr[idx] = pd;
  set_initial_context(idx, tag);
  proc_data_frame[idx] = data;
  proc_used[idx] = 1;
  return idx;
}

// Duplicate an existing process into a fresh, isolated address space (fork).
int fork_process(int parent) {
  int idx;
  int pd;
  int i;
  idx = nproc;
  nproc = nproc + 1;
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
  proc_data_frame[idx] = get_phys(pd, ${L.userData});
  proc_used[idx] = 1;
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

// Called by the timer stub with the interrupted process's state already spilled
// into sctx_*. Save it, round-robin to the next process, load its state, and
// switch the live page directory; the stub then IRETs into that process.
void on_timer() {
  ticks = ticks + 1;
  save_ctx(current);
  current = (current + 1) % nproc;
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

// --- trap table ---

void set_idt_entry(int vector, int handler) {
  int *entry;
  entry = ${L.idt} + vector * ${IDT_ENTRY_SIZE};
  entry[0] = handler;
  entry[1] = ${IDT_PRESENT};
}

void capture_handlers() {
  asm("
    MOV R1, phase12_default_handler
    STORE R1, default_handler_addr
    MOV R1, phase12_timer_handler
    STORE R1, timer_handler_addr
    MOV R1, phase12_pf_handler
    STORE R1, pf_handler_addr
  ");
}

void setup_traps() {
  int v;
  capture_handlers();
  __lidt(${L.idt});
  v = 0;
  while (v < 256) {
    set_idt_entry(v, default_handler_addr);
    v = v + 1;
  }
  set_idt_entry(${PHASE12_TIMER_VECTOR}, timer_handler_addr);
  set_idt_entry(${TRAP.PAGEFAULT}, pf_handler_addr);
  __lksp(${L.kstackTop});
}

int kmain() {
  asm("
    JMP phase12_handlers_done

  phase12_timer_handler:
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
  phase12_resume:
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

  phase12_pf_handler:
    CALL on_page_fault

  phase12_default_handler:
    CALL on_default_trap

  phase12_handlers_done:
  ");

  serial_write("phase12: boot\n");
  setup_traps();
  pmm_init();
  build_kernel_pt();

  // Two independent processes plus a fork of the first: three isolated spaces.
  setup_process(0xa1);
  setup_process(0xb2);
  fork_process(0);
  serial_write("phase12: procs\n");

  __stmr(${L.timerPeriod});
  current = 0;
  __lptbr(proc_ptbr[0]);
  __pgon();
  load_ctx(0);
  serial_write("phase12: enter user\n");

  // Hand the CPU to the first process; from here the kernel only runs inside
  // the timer handler, round-robin switching the three processes forever.
  asm("JMP phase12_resume");
  return 0;
}
`;
}

export const PHASE12_GUEST_KERNEL_SOURCE = phase12Source();

export function buildPhase12KernelImage(): KernelImage {
  return linkKernelImage([
    compileC(PHASE12_GUEST_KERNEL_SOURCE, {
      start: 'kernel',
      cStackSize: 8192,
      moduleId: 'phase12',
    }),
  ]);
}
