// Round-robin scheduler and context switching. The timer IRQ saves the
// interrupted context, picks the next runnable process, and reloads it.
#include "kernel.h"

int ticks;
int current;

void save_ctx(int i) {
  proc_table[i].ctx.regs[0] = sctx_r0;
  proc_table[i].ctx.regs[1] = sctx_r1;
  proc_table[i].ctx.regs[2] = sctx_r2;
  proc_table[i].ctx.regs[3] = sctx_r3;
  proc_table[i].ctx.regs[4] = sctx_r4;
  proc_table[i].ctx.regs[5] = sctx_r5;
  proc_table[i].ctx.regs[6] = sctx_r6;
  proc_table[i].ctx.regs[7] = sctx_r7;
  proc_table[i].ctx.pc = sctx_pc;
  proc_table[i].ctx.sp = sctx_sp;
  proc_table[i].ctx.flags = sctx_flags;
  proc_table[i].ctx.mode = sctx_mode;
}

void load_ctx(int i) {
  sctx_r0 = proc_table[i].ctx.regs[0];
  sctx_r1 = proc_table[i].ctx.regs[1];
  sctx_r2 = proc_table[i].ctx.regs[2];
  sctx_r3 = proc_table[i].ctx.regs[3];
  sctx_r4 = proc_table[i].ctx.regs[4];
  sctx_r5 = proc_table[i].ctx.regs[5];
  sctx_r6 = proc_table[i].ctx.regs[6];
  sctx_r7 = proc_table[i].ctx.regs[7];
  sctx_pc = proc_table[i].ctx.pc;
  sctx_sp = proc_table[i].ctx.sp;
  sctx_flags = proc_table[i].ctx.flags;
  sctx_mode = proc_table[i].ctx.mode;
}

int schedule(void) {
  int n;
  int idx;
  n = 0;
  while (n < nproc) {
    idx = (current + 1 + n) % nproc;
    if (proc_table[idx].state == CFG_ST_RUNNABLE) {
      return idx;
    }
    n = n + 1;
  }
  return -1;
}

// Block process idx on a wait channel and switch away. The caller has already
// arranged for its condition to be re-checked when it wakes (typically by
// rewinding pc so the syscall re-runs).
void sleep(int idx, int chan) {
  proc_table[idx].chan = chan;
  proc_table[idx].state = CFG_ST_SLEEPING;
  switch_to_next();
}

// Make every process sleeping on `chan` runnable. Spurious wakeups are harmless:
// a woken process re-checks its condition and sleeps again if needed.
void wakeup(int chan) {
  int i;
  i = 0;
  while (i < nproc) {
    if (proc_table[i].state == CFG_ST_SLEEPING && proc_table[i].chan == chan) {
      proc_table[i].state = CFG_ST_RUNNABLE;
    }
    i = i + 1;
  }
}

void switch_to_next(void) {
  int next;
  next = schedule();
  while (next < 0) {
    int i;
    int blocked;
    int deadline;
    i = 0;
    blocked = 0;
    deadline = 0;
    while (i < nproc) {
      if (proc_table[i].state == CFG_ST_SLEEPING ||
          proc_table[i].state == CFG_ST_STOPPED) {
        blocked = 1;
      }
      if (proc_table[i].state == CFG_ST_SLEEPING &&
          proc_table[i].sleep_deadline != 0 &&
          (deadline == 0 || proc_table[i].sleep_deadline < deadline)) {
        deadline = proc_table[i].sleep_deadline;
      }
      i = i + 1;
    }
    if (blocked == 0) {
      klog("kernel: all processes exited\n");
      __halt();
    }
    // The VM timer advances with executed instructions, so HLT cannot wake a
    // system whose only sleepers are waiting for time. Fast-forward the
    // deterministic guest clock to the next deadline and make due sleepers
    // runnable. When another process is runnable, normal timer IRQs advance it.
    if (deadline != 0) {
      ticks = deadline;
      i = 0;
      while (i < nproc) {
        if (proc_table[i].state == CFG_ST_SLEEPING &&
            proc_table[i].sleep_deadline != 0 &&
            ticks >= proc_table[i].sleep_deadline) {
          if (proc_table[i].poll_deadline != 0) {
            proc_table[i].ctx.pc =
              proc_table[i].ctx.pc + CFG_SYSCALL_INSTR_SIZE;
            proc_table[i].poll_deadline = 0;
          } else if (proc_table[i].tty_deadline != 0) {
            proc_table[i].tty_deadline = 0;
            proc_table[i].tty_timed_out = 1;
          }
          proc_table[i].sleep_deadline = 0;
          proc_table[i].sleep_remaining = 0;
          proc_table[i].ctx.regs[0] = 0;
          proc_table[i].state = CFG_ST_RUNNABLE;
        }
        i = i + 1;
      }
      next = schedule();
    }
    if (next >= 0) {
      continue;
    }
    __stmr(0);
    __ei();
    __halt();
    __di();
    next = schedule();
  }
  __stmr(CFG_TIMER_PERIOD);
  current = next;
  prepare_signal(current);
}

void on_timer(void) {
  int next;
  int i;
  if (sctx_mode != CFG_MODE_USER) {
    panic("timer outside user");
  }
  ticks = ticks + 1;
  save_ctx(current);
  i = 0;
  while (i < nproc) {
    if (proc_table[i].state == CFG_ST_SLEEPING &&
        proc_table[i].sleep_deadline != 0 &&
        ticks >= proc_table[i].sleep_deadline) {
      if (proc_table[i].poll_deadline != 0) {
        proc_table[i].ctx.pc =
          proc_table[i].ctx.pc + CFG_SYSCALL_INSTR_SIZE;
        proc_table[i].poll_deadline = 0;
      } else if (proc_table[i].tty_deadline != 0) {
        proc_table[i].tty_deadline = 0;
        proc_table[i].tty_timed_out = 1;
      }
      proc_table[i].sleep_deadline = 0;
      proc_table[i].sleep_remaining = 0;
      proc_table[i].ctx.regs[0] = 0;
      proc_table[i].state = CFG_ST_RUNNABLE;
    }
    i = i + 1;
  }
  next = schedule();
  if (next < 0) {
    panic("no runnable process in timer");
  }
  current = next;
  prepare_signal(current);
  load_ctx(current);
  __lptbr(proc_table[current].vm.ptbr);
}
