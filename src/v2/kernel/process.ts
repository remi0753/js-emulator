// Process abstraction (v2). Each process has its own address space (page
// directory) and a saved CPU state used as its trap frame across context switches.

import type { CpuState } from '../hw/cpu.ts';

export type ProcState = 'ready' | 'running' | 'zombie';

export interface Process {
  pid: number;
  name: string;
  state: ProcState;
  exitCode: number | null;
  pd: number; // page-directory physical address (this process's address space)
  cpu: CpuState; // saved registers / pc / sp / flags / mode / ptbr
}
