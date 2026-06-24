// Process table and lifecycle: allocation, fork, boot of the initial process,
// and the runnable/zombie/blocked transitions behind exit/wait.
//
// Related process, VM, context, and descriptor state lives in one proc object.
// The assembly trap stub still uses the fixed sctx_* scratch globals and the
// scheduler copies between that scratch area and proc_table[].ctx.
#include "kernel.h"

int nproc;
struct proc proc_table[CFG_MAX_PROC];

int alloc_proc(void) {
  int i;
  i = 0;
  while (i < nproc) {
    if (proc_table[i].state == CFG_ST_UNUSED) {
      return i;
    }
    i = i + 1;
  }
  if (nproc >= CFG_MAX_PROC) {
    panic("too many processes");
  }
  i = nproc;
  nproc = nproc + 1;
  return i;
}

int setup_process_boot(int path) {
  int idx;
  idx = alloc_proc();
  build_args_single(path);
  if (spawn(idx, path) < 0) {
    panic("boot: invalid init executable");
  }
  proc_table[idx].parent = -1;
  proc_table[idx].state = CFG_ST_RUNNABLE;
  init_fds(idx);
  return idx;
}

int fork_process(int parent) {
  int idx;
  int pd;
  int i;
  if (parent < 0 || parent >= nproc || proc_table[parent].state == CFG_ST_UNUSED) {
    panic("bad fork parent");
  }
  idx = alloc_proc();
  pd = new_address_space();
  copy_space(proc_table[parent].vm.ptbr, pd);
  proc_table[idx].vm.ptbr = pd;
  i = 0;
  while (i < 8) {
    proc_table[idx].ctx.regs[i] = proc_table[parent].ctx.regs[i];
    i = i + 1;
  }
  proc_table[idx].ctx.pc = proc_table[parent].ctx.pc;
  proc_table[idx].ctx.sp = proc_table[parent].ctx.sp;
  proc_table[idx].ctx.mode = proc_table[parent].ctx.mode;
  proc_table[idx].ctx.flags = proc_table[parent].ctx.flags;
  return idx;
}

int do_fork(int parent) {
  int idx;
  idx = fork_process(parent);
  proc_table[idx].parent = parent;
  proc_table[idx].state = CFG_ST_RUNNABLE;
  copy_fds(idx, parent);
  proc_table[idx].ctx.regs[0] = 0; // child sees fork() == 0
  return idx;
}

int do_exit(int idx, int code) {
  int p;
  proc_table[idx].exit_code = code;
  clear_fds(idx); // releasing pipe ends wakes blocked peers (see fd_close)
  proc_table[idx].state = CFG_ST_ZOMBIE;
  p = proc_table[idx].parent;
  if (p >= 0) {
    wakeup(&proc_table[p]); // a parent sleeping in wait() re-checks for zombies
  }
  return 0;
}

int do_wait(int parent) {
  int i;
  int alive;
  i = 0;
  while (i < nproc) {
    if (proc_table[i].parent == parent && proc_table[i].state == CFG_ST_ZOMBIE) {
      proc_table[parent].ctx.regs[0] = i;
      proc_table[i].state = CFG_ST_UNUSED;
      return proc_table[i].vm.ptbr; // reaped child's address space, freed by the caller
    }
    i = i + 1;
  }
  alive = 0;
  i = 0;
  while (i < nproc) {
    if (proc_table[i].parent == parent && proc_table[i].state != CFG_ST_UNUSED) {
      alive = 1;
    }
    i = i + 1;
  }
  if (alive == 0) {
    proc_table[parent].ctx.regs[0] = -CFG_ECHILD;
    return 0;
  }
  // Block until a child exits, then re-run the syscall to reap it.
  proc_table[parent].ctx.pc = proc_table[parent].ctx.pc - CFG_SYSCALL_INSTR_SIZE;
  sleep(parent, &proc_table[parent]);
  return 0;
}
