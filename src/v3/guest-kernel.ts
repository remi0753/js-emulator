import { IDT_ENTRY_SIZE, IDT_PRESENT, TIMER_IRQ, TRAP } from '../isa.ts';
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
