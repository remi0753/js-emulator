// Process table and lifecycle: allocation, fork, boot of the initial process,
// and the runnable/zombie/blocked transitions behind exit/wait.
//
// Per-process state is stored as flat arrays so the assembly trap stub can also
// reach the live trap registers through fixed global labels (sctx_*).
#include "kernel.h"

int nproc;
int proc_state[CFG_MAX_PROC];   // unused / runnable / zombie / blocked / pipewait
int proc_parent[CFG_MAX_PROC];  // parent slot, -1 for the initial process
int proc_exit_code[CFG_MAX_PROC];
int proc_ptbr[CFG_MAX_PROC];
int proc_regs[CFG_PROC_REG_COUNT]; // proc * 8 + register number
int proc_pc[CFG_MAX_PROC];
int proc_sp[CFG_MAX_PROC];
int proc_flags[CFG_MAX_PROC];
int proc_mode[CFG_MAX_PROC];

int alloc_proc(void) {
  int i;
  i = 0;
  while (i < nproc) {
    if (proc_state[i] == CFG_ST_UNUSED) {
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
  proc_parent[idx] = -1;
  proc_state[idx] = CFG_ST_RUNNABLE;
  init_fds(idx);
  return idx;
}

int fork_process(int parent) {
  int idx;
  int pd;
  int i;
  if (parent < 0 || parent >= nproc || proc_state[parent] == CFG_ST_UNUSED) {
    panic("bad fork parent");
  }
  idx = alloc_proc();
  pd = new_address_space();
  copy_space(proc_ptbr[parent], pd);
  proc_ptbr[idx] = pd;
  i = 0;
  while (i < 8) {
    proc_regs[idx * 8 + i] = proc_regs[parent * 8 + i];
    i = i + 1;
  }
  proc_pc[idx] = proc_pc[parent];
  proc_sp[idx] = proc_sp[parent];
  proc_mode[idx] = proc_mode[parent];
  proc_flags[idx] = proc_flags[parent];
  return idx;
}

int do_fork(int parent) {
  int idx;
  idx = fork_process(parent);
  proc_parent[idx] = parent;
  proc_state[idx] = CFG_ST_RUNNABLE;
  copy_fds(idx, parent);
  proc_regs[idx * 8 + 0] = 0; // child sees fork() == 0
  return idx;
}

int do_exit(int idx, int code) {
  int p;
  proc_exit_code[idx] = code;
  clear_fds(idx);
  wake_pipe_waiters(); // closing write ends may signal EOF to readers
  proc_state[idx] = CFG_ST_ZOMBIE;
  p = proc_parent[idx];
  if (p >= 0 && proc_state[p] == CFG_ST_BLOCKED) {
    proc_regs[p * 8 + 0] = idx;
    proc_state[p] = CFG_ST_RUNNABLE;
    proc_state[idx] = CFG_ST_UNUSED;
    return proc_ptbr[idx];
  }
  return 0;
}

int do_wait(int parent) {
  int i;
  int alive;
  i = 0;
  while (i < nproc) {
    if (proc_parent[i] == parent && proc_state[i] == CFG_ST_ZOMBIE) {
      proc_regs[parent * 8 + 0] = i;
      proc_state[i] = CFG_ST_UNUSED;
      return proc_ptbr[i];
    }
    i = i + 1;
  }
  alive = 0;
  i = 0;
  while (i < nproc) {
    if (proc_parent[i] == parent && proc_state[i] != CFG_ST_UNUSED) {
      alive = 1;
    }
    i = i + 1;
  }
  if (alive == 0) {
    proc_regs[parent * 8 + 0] = -1;
    return 0;
  }
  proc_state[parent] = CFG_ST_BLOCKED;
  switch_to_next();
  return 0;
}
