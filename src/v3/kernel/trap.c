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
int network_handler_addr;

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
    "MOV R1, kernel_network_handler\n"
    "STORE R1, network_handler_addr\n"
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
  set_idt_entry(CFG_NET_VECTOR, network_handler_addr);
  set_user_idt_entry(CFG_SYSCALL_VECTOR, syscall_handler_addr);
  __lksp(CFG_KSTACK_TOP);
}

void on_default_trap(void) {
  klog("kernel: unexpected trap pc=");
  klog_int(sctx_pc);
  klog(" sp=");
  klog_int(sctx_sp);
  klog(" mode=");
  klog_int(sctx_mode);
  klog(" err=");
  klog_int(__rderr());
  klog("\n");
  panic("unexpected trap");
}

// Print a simple backtrace for a faulting user process: the faulting pc is the
// innermost frame; the rest is found by scanning the user (hardware) stack for
// words that point into the loaded image [USER_BASE, brk_start), i.e. return
// addresses left by CALL. It is heuristic — a pushed pointer into the image can
// look like a return address — so it over-reports rather than miss frames, and
// the host symbolizer (tools/symbolize-guest-cc.ts) drops words that don't land
// on a function. Values are decimal to match klog_int; feed them straight to the
// symbolizer. This is what turns a guest cc crash from "addr=8, now go map a pc
// by hand" into a ready-to-read call chain.
void user_backtrace(int proc, int pc, int sp) {
  int text_lo;
  int text_hi;
  int addr;
  int phys;
  int word;
  int scanned;
  int printed;
  text_lo = CFG_USER_BASE;
  text_hi = proc_table[proc].vm.brk_start; // end of the loaded image (text+data)
  klog("kernel: backtrace (decimal pcs; symbolize with tools/symbolize-guest-cc.ts):\n");
  klog("  ");
  klog_int(pc); // innermost frame: where the fault happened
  scanned = 0;
  printed = 1;
  addr = sp;
  while (scanned < 2048 && printed < 32) {
    phys = user_phys_addr(proc, addr, 0);
    if (phys < 0) {
      break; // walked off the mapped stack
    }
    word = read32_at(phys);
    if (word >= text_lo && word < text_hi) {
      klog(" ");
      klog_int(word);
      printed = printed + 1;
    }
    addr = addr + 4;
    scanned = scanned + 1;
  }
  klog("\n");
}

void on_page_fault(void) {
  int error;
  page_fault_addr = __rdpfla();
  error = __rderr();
  if ((trace_flags & CFG_TRACE_FAULT) != 0) {
    klog("trace: fault pid=");
    klog_int(current);
    klog(" addr=");
    klog_int(page_fault_addr);
    klog(" err=");
    klog_int(error);
    klog("\n");
  }
  if (sctx_mode != CFG_MODE_USER) {
    panic("unexpected kernel page fault");
  }
  save_ctx(current);
  if (vm_handle_page_fault(current, page_fault_addr, error) == 0) {
    load_ctx(current);
    __lptbr(proc_table[current].vm.ptbr);
    return;
  }
  // An unresolved user fault kills the process with SIGSEGV. The default action
  // is silent, so a guest program that derefs a bad pointer just vanishes mid-run
  // (e.g. the compiler dying part-way leaves a truncated .s and a baffling
  // downstream "undefined symbol"). Log it unconditionally — pid, faulting
  // address, faulting pc, and error bits — so the failure is visible without
  // having to set CFG_TRACE_FAULT ahead of time.
  klog("kernel: SIGSEGV pid=");
  klog_int(current);
  klog(" addr=");
  klog_int(page_fault_addr);
  klog(" pc=");
  klog_int(sctx_pc);
  klog(" err=");
  klog_int(error);
  klog("\n");
  user_backtrace(current, sctx_pc, sctx_sp);
  send_signal(current, CFG_SIGSEGV);
  prepare_signal(current);
  load_ctx(current);
  __lptbr(proc_table[current].vm.ptbr);
}
