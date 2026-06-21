// OS layer (v1): PCB / round-robin scheduler / syscall dispatch / program loader.
//
// It uses the fact that the CPU's run(QUANTUM) always returns to JS to do time
// slicing in plain JS, which is what makes the multitasking preemptive.

import { assemble } from './assembler.ts';
import { type Context, CPU, MEM_SIZE, type RunResult } from './cpu.ts';
import { SYS, SYSCALL_INT } from './isa.ts';

export type ProcState = 'ready' | 'running' | 'blocked' | 'terminated';

// Process Control Block
export interface PCB {
  pid: number;
  name: string;
  programId: number;
  ctx: Context;
  state: ProcState;
  exitCode: number | null;
  wakeAt: number; // SLEEP wake-up time (in clock units)
}

interface Program {
  id: number;
  name: string;
  bytes: Uint8Array;
}

export interface OSOptions {
  quantum?: number; // instructions granted to one process per slice
  // Console sink. Replaceable for tests. Receives the char and the emitting process.
  onWrite?: (char: string, pcb: PCB) => void;
  log?: (msg: string) => void; // kernel log (termination / faults / etc.)
}

export class OS {
  private cpu = new CPU();
  private programs = new Map<number, Program>();
  private nextProgramId = 1;

  processes = new Map<number, PCB>();
  private readyQueue: PCB[] = [];
  private sleepers: PCB[] = [];
  private nextPid = 1;
  private clock = 0; // elapsed time = number of quanta executed

  readonly quantum: number;
  private onWrite: (char: string, pcb: PCB) => void;
  private log: (msg: string) => void;

  // All collected console output (for tests / inspection).
  output = '';

  constructor(opts: OSOptions = {}) {
    this.quantum = opts.quantum ?? 1000;
    this.onWrite = opts.onWrite ?? ((c) => process.stdout.write(c));
    this.log = opts.log ?? (() => {});
  }

  // --- program management ---

  // Register an assembly source and return a program ID usable by SPAWN.
  loadProgram(name: string, source: string): number {
    const { bytes } = assemble(source);
    const id = this.nextProgramId++;
    this.programs.set(id, { id, name, bytes });
    return id;
  }

  // --- process creation (loader) ---

  // Create a new process from a program ID and enqueue it. Returns null on failure.
  spawn(programId: number): PCB | null {
    const prog = this.programs.get(programId);
    if (!prog) return null;

    // v1: each process gets an independent memory image (process isolation).
    const mem = new Uint8Array(MEM_SIZE);
    mem.set(prog.bytes, 0);

    const pcb: PCB = {
      pid: this.nextPid++,
      name: prog.name,
      programId,
      ctx: { regs: new Array(8).fill(0), pc: 0, sp: MEM_SIZE, flags: 0, mem },
      state: 'ready',
      exitCode: null,
      wakeAt: 0,
    };
    this.processes.set(pcb.pid, pcb);
    this.readyQueue.push(pcb);
    return pcb;
  }

  // --- scheduler (main loop) ---

  run(): void {
    while (this.readyQueue.length > 0 || this.sleepers.length > 0) {
      if (this.readyQueue.length === 0) {
        // Nothing runnable, only sleepers -> advance the clock to wake them.
        this.advanceClockToNextWake();
        continue;
      }

      const pcb = this.readyQueue.shift()!;
      pcb.state = 'running';

      this.cpu.loadContext(pcb.ctx);
      const r = this.cpu.run(this.quantum);
      this.cpu.saveContext(pcb.ctx);

      this.clock++; // one quantum of time elapsed
      this.wakeSleepers();

      this.dispatch(pcb, r);
    }
  }

  private dispatch(pcb: PCB, r: RunResult): void {
    switch (r.reason) {
      case 'quantum': // time slice expired -> to the tail (round-robin)
        this.makeReady(pcb);
        break;
      case 'int':
        if (r.int === SYSCALL_INT) this.handleSyscall(pcb);
        else {
          this.log(`pid ${pcb.pid}: unsupported INT 0x${r.int.toString(16)} -> terminating`);
          this.terminate(pcb, -1);
        }
        break;
      case 'halt': // HLT -> process exit
        this.log(`pid ${pcb.pid} (${pcb.name}): HLT`);
        this.terminate(pcb, 0);
        break;
      case 'fault':
        this.log(`pid ${pcb.pid} (${pcb.name}): fault: ${r.message} -> killed`);
        this.terminate(pcb, -1);
        break;
    }
  }

  // --- syscall dispatch ---

  private handleSyscall(pcb: PCB): void {
    const regs = pcb.ctx.regs;
    const num = regs[0]!; // R0 = syscall number
    const a1 = regs[1]!; // R1 = first argument

    switch (num) {
      case SYS.EXIT:
        this.log(`pid ${pcb.pid} (${pcb.name}): EXIT code=${a1}`);
        this.terminate(pcb, a1);
        break;

      case SYS.WRITE: {
        const char = String.fromCharCode(a1 & 0xff);
        this.output += char;
        this.onWrite(char, pcb);
        regs[0] = 0; // return value
        this.makeReady(pcb);
        break;
      }

      case SYS.YIELD: // voluntarily give up the CPU -> to the tail
        this.makeReady(pcb);
        break;

      case SYS.GETPID:
        regs[0] = pcb.pid;
        this.makeReady(pcb);
        break;

      case SYS.SPAWN: {
        const child = this.spawn(a1); // R1 = program ID
        regs[0] = child ? child.pid : 0xffffffff; // failure = -1 (unsigned)
        this.makeReady(pcb);
        break;
      }

      case SYS.SLEEP: // block until R1 ticks have passed
        pcb.state = 'blocked';
        pcb.wakeAt = this.clock + a1;
        this.sleepers.push(pcb);
        break;

      default:
        this.log(`pid ${pcb.pid}: unknown syscall ${num}`);
        regs[0] = 0xffffffff;
        this.makeReady(pcb);
        break;
    }
  }

  // --- process state transition helpers ---

  private makeReady(pcb: PCB): void {
    pcb.state = 'ready';
    this.readyQueue.push(pcb);
  }

  private terminate(pcb: PCB, code: number): void {
    pcb.state = 'terminated';
    pcb.exitCode = code | 0;
    // Not requeued. Kept in `processes` for the record.
  }

  // --- sleep management (v1 substitute for a real timer) ---

  private wakeSleepers(): void {
    if (this.sleepers.length === 0) return;
    const still: PCB[] = [];
    for (const pcb of this.sleepers) {
      if (pcb.wakeAt <= this.clock) this.makeReady(pcb);
      else still.push(pcb);
    }
    this.sleepers = still;
  }

  private advanceClockToNextWake(): void {
    let next = Infinity;
    for (const pcb of this.sleepers) next = Math.min(next, pcb.wakeAt);
    if (next === Infinity) return; // safety (avoid deadlock)
    this.clock = next;
    this.wakeSleepers();
  }
}
