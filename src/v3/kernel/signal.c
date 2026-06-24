// Signals, process groups, sessions, and signal delivery.
//
// A pending signal is delivered immediately before returning to user mode.
// Caught signals run on the interrupted user hardware stack and return through
// a libc restorer that invokes sigreturn. The complete interrupted CPU context
// stays in the PCB.
#include "kernel.h"

int default_ignored(int signal);

int signal_bit(int signal) {
  return 1 << signal;
}

int signal_cannot_catch(int signal) {
  return signal == CFG_SIGKILL || signal == CFG_SIGSTOP;
}

void signal_init_proc(int idx) {
  int signal;
  proc_table[idx].pending_signals = 0;
  proc_table[idx].blocked_signals = 0;
  proc_table[idx].in_signal = 0;
  proc_table[idx].wait_event = 0;
  proc_table[idx].wait_signal = 0;
  proc_table[idx].sleep_deadline = 0;
  proc_table[idx].sleep_remaining = 0;
  signal = 0;
  while (signal < CFG_NSIG) {
    proc_table[idx].signal_handlers[signal] = CFG_SIG_DFL;
    proc_table[idx].signal_masks[signal] = 0;
    proc_table[idx].signal_restorers[signal] = 0;
    signal = signal + 1;
  }
}

void signal_fork_proc(int child, int parent) {
  int signal;
  proc_table[child].pending_signals = 0;
  proc_table[child].blocked_signals = proc_table[parent].blocked_signals;
  proc_table[child].in_signal = 0;
  proc_table[child].wait_event = 0;
  proc_table[child].wait_signal = 0;
  proc_table[child].sleep_deadline = 0;
  proc_table[child].sleep_remaining = 0;
  signal = 0;
  while (signal < CFG_NSIG) {
    proc_table[child].signal_handlers[signal] =
      proc_table[parent].signal_handlers[signal];
    proc_table[child].signal_masks[signal] =
      proc_table[parent].signal_masks[signal];
    proc_table[child].signal_restorers[signal] =
      proc_table[parent].signal_restorers[signal];
    signal = signal + 1;
  }
}

void signal_exec_proc(int idx) {
  int signal;
  proc_table[idx].pending_signals = 0;
  proc_table[idx].in_signal = 0;
  signal = 1;
  while (signal < CFG_NSIG) {
    if (proc_table[idx].signal_handlers[signal] != CFG_SIG_IGN) {
      proc_table[idx].signal_handlers[signal] = CFG_SIG_DFL;
      proc_table[idx].signal_masks[signal] = 0;
      proc_table[idx].signal_restorers[signal] = 0;
    }
    signal = signal + 1;
  }
}

void notify_parent(int idx) {
  int parent;
  parent = proc_table[idx].parent;
  if (parent >= 0) {
    proc_table[parent].pending_signals =
      proc_table[parent].pending_signals | signal_bit(CFG_SIGCHLD);
    wakeup(&proc_table[parent]);
  }
}

int send_signal(int idx, int signal) {
  int handler;
  int blocked;
  if (idx < 0 || idx >= nproc || proc_table[idx].state == CFG_ST_UNUSED) {
    return -CFG_ESRCH;
  }
  if (signal < 0 || signal >= CFG_NSIG) {
    return -CFG_EINVAL;
  }
  if (signal == 0) {
    return 0;
  }
  if (signal == CFG_SIGCONT && proc_table[idx].state == CFG_ST_STOPPED) {
    proc_table[idx].state = CFG_ST_RUNNABLE;
    proc_table[idx].wait_event = CFG_WCONTINUED;
    proc_table[idx].wait_signal = signal;
    notify_parent(idx);
  }
  proc_table[idx].pending_signals =
    proc_table[idx].pending_signals | signal_bit(signal);
  handler = proc_table[idx].signal_handlers[signal];
  blocked = (proc_table[idx].blocked_signals & signal_bit(signal)) != 0;
  if (signal_cannot_catch(signal)) blocked = 0;
  if (proc_table[idx].state == CFG_ST_SLEEPING && blocked == 0 &&
      handler != CFG_SIG_IGN &&
      !(handler == CFG_SIG_DFL && default_ignored(signal))) {
    // Blocking operations rewind PC to retry their INT. A signal interrupts the
    // operation instead: resume after INT with -EINTR after the handler returns.
    if (proc_table[idx].sleep_deadline != 0) {
      int remaining;
      int value[2];
      remaining = proc_table[idx].sleep_deadline - ticks;
      if (remaining < 0) {
        remaining = 0;
      }
      value[0] = remaining / CFG_TICKS_PER_SEC;
      value[1] = (remaining % CFG_TICKS_PER_SEC) *
        (1000000000 / CFG_TICKS_PER_SEC);
      if (proc_table[idx].sleep_remaining != 0) {
        copyout(idx, proc_table[idx].sleep_remaining, value, 8);
      }
      proc_table[idx].sleep_deadline = 0;
      proc_table[idx].sleep_remaining = 0;
    } else {
      proc_table[idx].ctx.pc =
        proc_table[idx].ctx.pc + CFG_SYSCALL_INSTR_SIZE;
    }
    proc_table[idx].ctx.regs[0] = -CFG_EINTR;
    proc_table[idx].state = CFG_ST_RUNNABLE;
  }
  if (proc_table[idx].state == CFG_ST_STOPPED &&
      (signal == CFG_SIGKILL || signal == CFG_SIGCONT)) {
    proc_table[idx].state = CFG_ST_RUNNABLE;
  }
  return 0;
}

int send_signal_group(int pgid, int signal) {
  int i;
  int found;
  found = 0;
  i = 0;
  while (i < nproc) {
    if (proc_table[i].state != CFG_ST_UNUSED && proc_table[i].pgid == pgid) {
      send_signal(i, signal);
      found = 1;
    }
    i = i + 1;
  }
  if (found == 0) {
    return -CFG_ESRCH;
  }
  return 0;
}

int send_signal_selector(int caller, int pid, int signal) {
  int i;
  int found;
  if (signal < 0 || signal >= CFG_NSIG) {
    return -CFG_EINVAL;
  }
  if (pid > 0) {
    return send_signal(pid, signal);
  }
  if (pid == 0) {
    return send_signal_group(proc_table[caller].pgid, signal);
  }
  if (pid < -1) {
    return send_signal_group(0 - pid, signal);
  }
  found = 0;
  i = 0;
  while (i < nproc) {
    if (proc_table[i].state != CFG_ST_UNUSED) {
      send_signal(i, signal);
      found = 1;
    }
    i = i + 1;
  }
  if (found == 0) {
    return -CFG_ESRCH;
  }
  return 0;
}

int next_deliverable_signal(int idx) {
  int signal;
  int pending;
  pending = proc_table[idx].pending_signals &
    ~proc_table[idx].blocked_signals;
  signal = 1;
  while (signal < CFG_NSIG) {
    if ((pending & signal_bit(signal)) != 0) {
      return signal;
    }
    signal = signal + 1;
  }
  return 0;
}

void stop_process(int idx, int signal) {
  proc_table[idx].state = CFG_ST_STOPPED;
  proc_table[idx].wait_event = CFG_WUNTRACED;
  proc_table[idx].wait_signal = signal;
  notify_parent(idx);
}

int default_ignored(int signal) {
  return signal == CFG_SIGCHLD || signal == CFG_SIGCONT;
}

int default_stops(int signal) {
  return signal == CFG_SIGSTOP || signal == CFG_SIGTSTP ||
    signal == CFG_SIGTTIN || signal == CFG_SIGTTOU;
}

void prepare_signal(int idx) {
  int signal;
  int handler;
  int restorer;
  int sp;
  int result;
  if (idx < 0 || proc_table[idx].state != CFG_ST_RUNNABLE ||
      proc_table[idx].in_signal != 0) {
    return;
  }
  while (1) {
    signal = next_deliverable_signal(idx);
    if (signal == 0) {
      return;
    }
    proc_table[idx].pending_signals =
      proc_table[idx].pending_signals & ~signal_bit(signal);
    handler = proc_table[idx].signal_handlers[signal];
    if (handler == CFG_SIG_IGN && !signal_cannot_catch(signal)) {
      continue;
    }
    if (handler == CFG_SIG_DFL || signal_cannot_catch(signal)) {
      if (default_ignored(signal)) {
        continue;
      }
      if (default_stops(signal)) {
        stop_process(idx, signal);
        switch_to_next();
        idx = current;
        continue;
      }
      do_exit(idx, 128 + signal);
      proc_table[idx].wait_signal = signal;
      switch_to_next();
      idx = current;
      continue;
    }

    restorer = proc_table[idx].signal_restorers[signal];
    if (restorer == 0) {
      do_exit(idx, 128 + CFG_SIGSEGV);
      switch_to_next();
      idx = current;
      continue;
    }
    memcpy(&proc_table[idx].signal_saved_ctx,
      &proc_table[idx].ctx, sizeof(struct cpu_context));
    proc_table[idx].signal_saved_mask = proc_table[idx].blocked_signals;
    proc_table[idx].in_signal = 1;
    proc_table[idx].blocked_signals =
      proc_table[idx].blocked_signals |
      proc_table[idx].signal_masks[signal] |
      signal_bit(signal);
    sp = proc_table[idx].ctx.sp - 4;
    result = copyout(idx, sp, &restorer, 4);
    if (result < 0) {
      do_exit(idx, 128 + CFG_SIGSEGV);
      switch_to_next();
      idx = current;
      continue;
    }
    proc_table[idx].ctx.sp = sp;
    proc_table[idx].ctx.pc = handler;
    proc_table[idx].ctx.regs[0] = signal;
    return;
  }
}

int sys_sigaction(int caller, int signal, int action, int old_action) {
  int data[4];
  if (signal <= 0 || signal >= CFG_NSIG) {
    return -CFG_EINVAL;
  }
  if (old_action != 0) {
    data[0] = proc_table[caller].signal_handlers[signal];
    data[1] = proc_table[caller].signal_masks[signal];
    data[2] = 0;
    data[3] = proc_table[caller].signal_restorers[signal];
    if (copyout(caller, old_action, data, 16) < 0) {
      return -CFG_EFAULT;
    }
  }
  if (action != 0) {
    if (copyin(caller, data, action, 16) < 0) {
      return -CFG_EFAULT;
    }
    if (signal_cannot_catch(signal) && data[0] != CFG_SIG_DFL) {
      return -CFG_EINVAL;
    }
    proc_table[caller].signal_handlers[signal] = data[0];
    proc_table[caller].signal_masks[signal] = data[1];
    proc_table[caller].signal_restorers[signal] = data[3];
  }
  return 0;
}

int sys_sigprocmask(int caller, int how, int mask, int old_mask) {
  if (old_mask != 0 &&
      copyout(caller, old_mask, &proc_table[caller].blocked_signals, 4) < 0) {
    return -CFG_EFAULT;
  }
  mask = mask & ~signal_bit(CFG_SIGKILL) & ~signal_bit(CFG_SIGSTOP);
  if (how == CFG_SIG_BLOCK) {
    proc_table[caller].blocked_signals =
      proc_table[caller].blocked_signals | mask;
  } else if (how == CFG_SIG_UNBLOCK) {
    proc_table[caller].blocked_signals =
      proc_table[caller].blocked_signals & ~mask;
  } else if (how == CFG_SIG_SETMASK) {
    proc_table[caller].blocked_signals = mask;
  } else {
    return -CFG_EINVAL;
  }
  return 0;
}

int sys_sigreturn(int caller) {
  if (proc_table[caller].in_signal == 0) {
    return -CFG_EINVAL;
  }
  memcpy(&proc_table[caller].ctx,
    &proc_table[caller].signal_saved_ctx, sizeof(struct cpu_context));
  proc_table[caller].blocked_signals = proc_table[caller].signal_saved_mask;
  proc_table[caller].in_signal = 0;
  return 0;
}

int sys_setpgid(int caller, int pid, int pgid) {
  int target;
  target = pid;
  if (target == 0) {
    target = caller;
  }
  if (target < 0 || target >= nproc ||
      proc_table[target].state == CFG_ST_UNUSED) {
    return -CFG_ESRCH;
  }
  if (target != caller && proc_table[target].parent != caller) {
    return -CFG_EPERM;
  }
  if (proc_table[target].sid != proc_table[caller].sid) {
    return -CFG_EPERM;
  }
  if (pgid == 0) {
    pgid = target;
  }
  proc_table[target].pgid = pgid;
  return 0;
}

int sys_setsid(int caller) {
  int i;
  i = 0;
  while (i < nproc) {
    if (proc_table[i].state != CFG_ST_UNUSED &&
        proc_table[i].pgid == caller) {
      return -CFG_EPERM;
    }
    i = i + 1;
  }
  proc_table[caller].sid = caller;
  proc_table[caller].pgid = caller;
  return caller;
}
