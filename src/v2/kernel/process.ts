// Process abstraction (v2). Each process has its own address space (page
// directory) and a saved CPU state used as its trap frame across context switches.

import type { CpuState } from '../hw/cpu.ts';

// 'waiting' = blocked in wait() until a child becomes a zombie.
// 'zombie'  = exited; its address space is freed but the PCB lingers so the
//             parent can read the exit code via wait() (then it is reaped).
export type ProcState = 'ready' | 'running' | 'waiting' | 'zombie';

export interface Process {
  pid: number;
  name: string;
  state: ProcState;
  exitCode: number | null;
  pd: number; // page-directory physical address (this process's address space)
  cpu: CpuState; // saved registers / pc / sp / flags / mode / ptbr

  // Process tree, for fork / wait / exit (reparenting and zombie reaping).
  parent: number | null; // parent pid (null for the first process / orphans)
  children: number[]; // live + zombie child pids
  waitStatusPtr: number; // user vaddr to store the child's exit code while waiting (0 = ignore)
}
