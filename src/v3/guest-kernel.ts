import { compileC } from '../toolchain/c.ts';
import { type KernelImage, linkKernelImage } from '../toolchain/linker.ts';
import { PORT } from '../vm/custom32/platform.ts';

export const PHASE11_KERNEL_LAYOUT = {
  idt: 0x8000,
  pageDirectory: 0x10000,
  pageTable0: 0x11000,
  demandVirtual: 0x90000,
  demandPhysical: 0x21000,
  stackTop: 0x70000,
} as const;

export const PHASE11_GUEST_KERNEL_SOURCE = String.raw`
int ticks;
int pf_count;
int page_fault_addr;
int page_fault_err;
int deliberate_value;
int idle_count;

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

void setup_traps() {
  asm("
    MOV R1, ${PHASE11_KERNEL_LAYOUT.idt}
    LIDT R1

    MOV R2, ${PHASE11_KERNEL_LAYOUT.idt + 32 * 8}
    MOV R3, phase11_timer_handler
    STORER R2, R3
    MOV R2, ${PHASE11_KERNEL_LAYOUT.idt + 32 * 8 + 4}
    MOV R3, 1
    STORER R2, R3

    MOV R2, ${PHASE11_KERNEL_LAYOUT.idt + 14 * 8}
    MOV R3, phase11_pf_handler
    STORER R2, R3
    MOV R2, ${PHASE11_KERNEL_LAYOUT.idt + 14 * 8 + 4}
    MOV R3, 1
    STORER R2, R3

    MOV R1, ${PHASE11_KERNEL_LAYOUT.stackTop}
    LKSP R1
  ");
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

  i = 0;
  while (i < 128) {
    pt[i] = (i * 4096) | 3;
    i = i + 1;
  }
  pd[0] = ${PHASE11_KERNEL_LAYOUT.pageTable0} | 3;

  __lptbr(${PHASE11_KERNEL_LAYOUT.pageDirectory});
  __pgon();
}

void trigger_page_fault() {
  int *src;
  int *faulting;

  src = ${PHASE11_KERNEL_LAYOUT.demandPhysical};
  *src = 0x51;

  faulting = ${PHASE11_KERNEL_LAYOUT.demandVirtual};
  deliberate_value = *faulting;
}

int kmain() {
  asm("
    JMP phase11_handlers_done

  phase11_timer_handler:
    PUSH R5
    PUSH R6
    LOAD R5, ticks
    INC R5
    STORE R5, ticks
    POP R6
    POP R5
    IRET

  phase11_pf_handler:
    PUSH R5
    PUSH R6
    RDPFLA R5
    STORE R5, page_fault_addr
    RDERR R5
    STORE R5, page_fault_err
    LOAD R5, pf_count
    INC R5
    STORE R5, pf_count
    MOV R5, ${PHASE11_KERNEL_LAYOUT.pageTable0 + (PHASE11_KERNEL_LAYOUT.demandVirtual >> 12) * 4}
    MOV R6, ${PHASE11_KERNEL_LAYOUT.demandPhysical | 3}
    STORER R5, R6
    POP R6
    POP R5
    IRET

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
