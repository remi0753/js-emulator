// Trap table setup and the C trap handlers. The assembly trap stubs live in
// main.c (kmain), since they must be skipped over during linear boot; this file
// captures their addresses and installs them in the IDT.
#include "kernel.h"

// Trap-frame scratch shared with the assembly trap/context-switch stubs.
int sctx_r0; int sctx_r1; int sctx_r2; int sctx_r3;
int sctx_r4; int sctx_r5; int sctx_r6; int sctx_r7;
int sctx_pc; int sctx_sp; int sctx_flags; int sctx_mode;

int page_fault_addr;

// Captured addresses of the assembly trap stubs (filled by capture_handlers()).
int default_handler_addr;
int timer_handler_addr;
int pf_handler_addr;
int syscall_handler_addr;
int keyboard_handler_addr;

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

void capture_handlers(void) {
  asm(
    "MOV R1, kernel_default_handler\n"
    "STORE R1, default_handler_addr\n"
    "MOV R1, kernel_timer_handler\n"
    "STORE R1, timer_handler_addr\n"
    "MOV R1, kernel_pf_handler\n"
    "STORE R1, pf_handler_addr\n"
    "MOV R1, kernel_syscall_handler\n"
    "STORE R1, syscall_handler_addr\n"
    "MOV R1, kernel_keyboard_handler\n"
    "STORE R1, keyboard_handler_addr\n"
  );
}

void setup_traps(void) {
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
  set_idt_entry(CFG_KBD_VECTOR, keyboard_handler_addr);
  set_user_idt_entry(CFG_SYSCALL_VECTOR, syscall_handler_addr);
  __lksp(CFG_KSTACK_TOP);
}

void on_default_trap(void) {
  panic("unexpected trap");
}

void on_page_fault(void) {
  page_fault_addr = __rdpfla();
  panic("unexpected page fault");
}
