// Round-robin scheduler and context switching. The timer IRQ saves the
// interrupted context, picks the next runnable process, and reloads it.
#include "kernel.h"

int ticks;
int current;

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

int schedule(void) {
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

void switch_to_next(void) {
  int next;
  next = schedule();
  while (next < 0) {
    int i;
    int blocked;
    i = 0;
    blocked = 0;
    while (i < nproc) {
      if (proc_state[i] == CFG_ST_BLOCKED || proc_state[i] == CFG_ST_PIPEWAIT) {
        blocked = 1;
      }
      i = i + 1;
    }
    if (blocked == 0) {
      serial_write("kernel: all processes exited\n");
      __halt();
    }
    __stmr(0);
    __ei();
    __halt();
    __di();
    next = schedule();
  }
  __stmr(CFG_TIMER_PERIOD);
  current = next;
}

void on_timer(void) {
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
