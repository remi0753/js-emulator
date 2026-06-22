// Process abstraction (v2). Each process has its own address space (page
// directory) and a saved CPU state used as its trap frame across context switches.

import type { CpuState } from '../../vm/custom32/cpu.ts';

// A reader parked on a resource (a pipe or the keyboard) until data is available.
export interface PendingRead {
  proc: Process;
  buf: number; // user vaddr to copy the data into
  len: number; // max bytes requested
}

// An in-kernel pipe: a byte FIFO with reference-counted read/write ends and a
// queue of readers blocked waiting for data.
export interface Pipe {
  buffer: number[];
  readers: number; // open read ends (the read-end OpenFile is live)
  writers: number; // open write ends
  readWaiters: PendingRead[];
}

// An open file (the object a file descriptor points to). Shared between fds when
// duplicated by fork/dup, so it carries a reference count.
export interface OpenFile {
  kind: 'console' | 'file' | 'pipe';
  inum: number; // FS inode number (kind === 'file')
  offset: number; // current read/write position
  readable: boolean;
  writable: boolean;
  ref: number; // number of file descriptors referring to this open file
  pipe?: Pipe; // backing pipe (kind === 'pipe')
}

// 'waiting' = blocked in wait() until a child becomes a zombie.
// 'blocked' = blocked in read() until input/pipe data is available.
// 'zombie'  = exited; its address space is freed but the PCB lingers so the
//             parent can read the exit code via wait() (then it is reaped).
export type ProcState = 'ready' | 'running' | 'waiting' | 'blocked' | 'zombie';

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

  // Open file descriptor table (index = fd). 0/1/2 are stdin/stdout/stderr.
  fds: (OpenFile | null)[];
}
