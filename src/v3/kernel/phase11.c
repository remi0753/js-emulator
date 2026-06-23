// Phase 11: a minimal guest kernel — serial output, panic, an IDT it fully
// owns, an identity-mapped page table, paging enabled from guest code, a bump
// frame allocator, a page-fault handler that maps on demand, and a timer IRQ.
//
// This is the guest-side source. CFG_* tokens are substituted with numeric
// literals by the loader in ../guest-kernel.ts (the single source of truth for
// the memory layout and ISA constants); everything else is the kernel itself.

int ticks;
int pf_count;
int page_fault_addr;
int page_fault_err;
int deliberate_value;
int idle_count;

int next_frame = CFG_FRAME_POOL_BASE;

// Captured addresses of the assembly trap stubs, filled by capture_handlers().
int default_handler_addr;
int timer_handler_addr;
int pf_handler_addr;

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
  if (next_frame >= CFG_FRAME_POOL_END) {
    panic("out of physical frames");
  }
  frame = next_frame;
  next_frame = next_frame + 4096;
  return frame;
}

// Install one IDT gate: [+0] handler address, [+4] flags.
void set_idt_entry(int vector, int handler) {
  int *entry;
  entry = CFG_IDT + vector * CFG_IDT_ENTRY_SIZE;
  entry[0] = handler;
  entry[1] = CFG_IDT_PRESENT;
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
  pt = CFG_PAGE_TABLE0;
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
  __lidt(CFG_IDT);

  // Own every vector: an unexpected trap reaches the guest and panics rather
  // than silently falling back to the host.
  v = 0;
  while (v < 256) {
    set_idt_entry(v, default_handler_addr);
    v = v + 1;
  }
  set_idt_entry(CFG_TIMER_VECTOR, timer_handler_addr);
  set_idt_entry(CFG_PAGEFAULT_VECTOR, pf_handler_addr);

  __lksp(CFG_STACK_TOP);
}

void setup_paging() {
  int *pd;
  int *pt;
  int i;

  pd = CFG_PAGE_DIRECTORY;
  pt = CFG_PAGE_TABLE0;

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
  pd[0] = CFG_PAGE_TABLE0 | 3;

  __lptbr(CFG_PAGE_DIRECTORY);
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
  faulting = CFG_DEMAND_VIRTUAL;
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
