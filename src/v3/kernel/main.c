// Guest kernel boot entry.
//
// The compiled guest kernel runs in privileged mode on the hardware-only
// Machine. kmain installs the trap table, brings up memory and the filesystem,
// reads the boot manifest to learn which program is init, execs it, and hands
// the CPU to userland; from there the kernel only runs inside trap handlers (the
// timer IRQ and INT 0x80), driving the compiled userland in guest code.
//
// The assembly trap stubs are defined at the top of kmain (behind a JMP that
// skips them during linear boot). trap.c captures their addresses and installs
// them in the IDT; scheduler.c / syscall.c provide the C handlers they call.
//
// CFG_* tokens are substituted by ../guest-kernel.ts (the single source of truth
// for the memory layout, ISA constants, syscall numbers, ports, FS format, and
// the executable header magic).
#include "kernel.h"

char initpath[CFG_INITPATH_LEN]; // path of the program named init by the boot manifest

void read_initpath(void) {
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

int kmain(void) {
  asm(
    "JMP kernel_handlers_done\n"
    "\n"
    "kernel_timer_handler:\n"
    "STORE R0, sctx_r0\n"
    "STORE R1, sctx_r1\n"
    "STORE R2, sctx_r2\n"
    "STORE R3, sctx_r3\n"
    "STORE R4, sctx_r4\n"
    "STORE R5, sctx_r5\n"
    "STORE R6, sctx_r6\n"
    "STORE R7, sctx_r7\n"
    "POP R0\n"
    "STORE R0, sctx_pc\n"
    "POP R0\n"
    "STORE R0, sctx_mode\n"
    "POP R0\n"
    "STORE R0, sctx_flags\n"
    "POP R0\n"
    "STORE R0, sctx_sp\n"
    "CALL on_timer\n"
    "JMP kernel_resume\n"
    "\n"
    "kernel_syscall_handler:\n"
    "STORE R0, sctx_r0\n"
    "STORE R1, sctx_r1\n"
    "STORE R2, sctx_r2\n"
    "STORE R3, sctx_r3\n"
    "STORE R4, sctx_r4\n"
    "STORE R5, sctx_r5\n"
    "STORE R6, sctx_r6\n"
    "STORE R7, sctx_r7\n"
    "POP R0\n"
    "STORE R0, sctx_pc\n"
    "POP R0\n"
    "STORE R0, sctx_mode\n"
    "POP R0\n"
    "STORE R0, sctx_flags\n"
    "POP R0\n"
    "STORE R0, sctx_sp\n"
    "CALL on_syscall\n"
    "JMP kernel_resume\n"
    "\n"
    "kernel_keyboard_handler:\n"
    "PUSH R0\n"
    "PUSH R1\n"
    "PUSH R2\n"
    "PUSH R3\n"
    "PUSH R4\n"
    "PUSH R5\n"
    "PUSH R6\n"
    "PUSH R7\n"
    "CALL on_keyboard_irq\n"
    "POP R7\n"
    "POP R6\n"
    "POP R5\n"
    "POP R4\n"
    "POP R3\n"
    "POP R2\n"
    "POP R1\n"
    "POP R0\n"
    "IRET\n"
    "\n"
    "kernel_network_handler:\n"
    "PUSH R0\n"
    "PUSH R1\n"
    "PUSH R2\n"
    "PUSH R3\n"
    "PUSH R4\n"
    "PUSH R5\n"
    "PUSH R6\n"
    "PUSH R7\n"
    "CALL on_network_irq\n"
    "POP R7\n"
    "POP R6\n"
    "POP R5\n"
    "POP R4\n"
    "POP R3\n"
    "POP R2\n"
    "POP R1\n"
    "POP R0\n"
    "IRET\n"
    "\n"
    "kernel_resume:\n"
    "LOAD R0, sctx_sp\n"
    "PUSH R0\n"
    "LOAD R0, sctx_flags\n"
    "PUSH R0\n"
    "LOAD R0, sctx_mode\n"
    "PUSH R0\n"
    "LOAD R0, sctx_pc\n"
    "PUSH R0\n"
    "LOAD R7, sctx_r7\n"
    "LOAD R6, sctx_r6\n"
    "LOAD R5, sctx_r5\n"
    "LOAD R4, sctx_r4\n"
    "LOAD R3, sctx_r3\n"
    "LOAD R2, sctx_r2\n"
    "LOAD R1, sctx_r1\n"
    "LOAD R0, sctx_r0\n"
    "IRET\n"
    "\n"
    "kernel_pf_handler:\n"
    "STORE R0, sctx_r0\n"
    "STORE R1, sctx_r1\n"
    "STORE R2, sctx_r2\n"
    "STORE R3, sctx_r3\n"
    "STORE R4, sctx_r4\n"
    "STORE R5, sctx_r5\n"
    "STORE R6, sctx_r6\n"
    "STORE R7, sctx_r7\n"
    "POP R0\n"
    "STORE R0, sctx_pc\n"
    "POP R0\n"
    "STORE R0, sctx_mode\n"
    "POP R0\n"
    "STORE R0, sctx_flags\n"
    "POP R0\n"
    "STORE R0, sctx_sp\n"
    "CALL on_page_fault\n"
    "JMP kernel_resume\n"
    "\n"
    "kernel_default_handler:\n"
    "CALL on_default_trap\n"
    "\n"
    "kernel_handlers_done:\n"
  );

  serial_write("kernel: boot\n");
  setup_traps();
  syscall_init();
  file_init();
  keyboard_init();
  network_init();
  device_init();
  pmm_init();
  build_kernel_pt();

  fs_mount();
  vfs_init();
  read_initpath();

  serial_write("kernel: exec ");
  serial_write(initpath);
  serial_putc('\n');
  setup_process_boot(initpath);

  __stmr(CFG_TIMER_PERIOD);
  current = 0;
  __lptbr(proc_table[0].vm.ptbr);
  __pgon();
  load_ctx(0);

  // Hand the CPU to init; from here the kernel only runs inside trap handlers
  // (the timer and INT 0x80), driving the compiled userland in guest code.
  asm("JMP kernel_resume");
  return 0;
}
