// The v2 kernel (TypeScript), running on the virtual hardware.
//
// It owns the physical/virtual memory managers, a timer-driven preemptive
// scheduler, syscall dispatch, and device drivers. User programs run as guest
// bytecode in USER mode; they enter the kernel only via trap / fault / IRQ.

import { CPU, type CpuState, MODE, type RunResult } from '../hw/cpu.ts';
import { Console } from '../hw/devices/console.ts';
import { PAGE_SIZE, PhysicalMemory } from '../hw/memory.ts';
import { PortBus } from '../hw/ports.ts';
import { FD, LAYOUT, PORT, SYS, SYSCALL_INT } from './abi.ts';
import { Pmm } from './pmm.ts';
import type { Process } from './process.ts';
import { BadAddress, PTE, Vmm } from './vmm.ts';

const PHYS_SIZE = 16 * 1024 * 1024; // 16 MiB physical RAM
const PMM_BASE = 1 * 1024 * 1024; // manage frames from 1 MiB up (low memory reserved)
const ERR = 0xffffffff; // syscall error return (-1 unsigned)

export interface KernelOptions {
  quantum?: number; // instructions per time slice
  consoleSink?: (s: string) => void; // where console output goes (tests capture it)
  log?: (msg: string) => void; // kernel log
}

export class Kernel {
  readonly phys: PhysicalMemory;
  readonly ports: PortBus;
  readonly cpu: CPU;
  readonly pmm: Pmm;
  readonly vmm: Vmm;
  readonly console: Console;

  readonly processes = new Map<number, Process>();
  private readyQueue: Process[] = [];
  private nextPid = 1;

  readonly quantum: number;
  private log: (msg: string) => void;

  constructor(opts: KernelOptions = {}) {
    this.quantum = opts.quantum ?? 1000;
    this.log = opts.log ?? (() => {});

    this.phys = new PhysicalMemory(PHYS_SIZE);
    this.ports = new PortBus();
    this.cpu = new CPU(this.phys, this.ports);
    this.pmm = new Pmm(this.phys, PMM_BASE);
    this.vmm = new Vmm(this.phys, this.cpu.mmu, this.pmm);

    this.console = new Console(opts.consoleSink);
    this.ports.register(PORT.CONSOLE_DATA, 1, this.console);
  }

  // --- process creation (loader) ---

  // Build an address space for a program image and start it in USER mode.
  spawn(name: string, image: Uint8Array): Process {
    const pd = this.vmm.createAddressSpace();

    // Map the program image (text + data) as user, writable.
    this.vmm.loadImage(pd, LAYOUT.USER_TEXT, image, PTE.U | PTE.W);

    // Map the user stack pages just below the stack top.
    for (let i = 1; i <= LAYOUT.USER_STACK_PAGES; i++) {
      this.vmm.mapPage(pd, LAYOUT.USER_STACK_TOP - i * PAGE_SIZE, PTE.U | PTE.W);
    }

    const cpu: CpuState = {
      regs: new Array(8).fill(0),
      pc: LAYOUT.USER_TEXT,
      sp: LAYOUT.USER_STACK_TOP,
      flags: 0,
      mode: MODE.USER,
      ptbr: pd,
      pagingEnabled: true,
    };

    const proc: Process = { pid: this.nextPid++, name, state: 'ready', exitCode: null, pd, cpu };
    this.processes.set(proc.pid, proc);
    this.readyQueue.push(proc);
    return proc;
  }

  // --- scheduler (timer-driven, preemptive round-robin) ---

  run(): void {
    while (this.readyQueue.length > 0) {
      const proc = this.readyQueue.shift()!;
      proc.state = 'running';

      this.cpu.loadState(proc.cpu);
      const r = this.cpu.run(this.quantum);
      this.cpu.saveState(proc.cpu);

      this.dispatch(proc, r);
    }
  }

  private dispatch(proc: Process, r: RunResult): void {
    switch (r.reason) {
      case 'timer': // quantum expired -> preempt, back to the tail
        this.ready(proc);
        break;
      case 'syscall':
        if (r.num === SYSCALL_INT) this.handleSyscall(proc);
        else {
          this.log(`pid ${proc.pid}: unexpected INT 0x${r.num.toString(16)} -> killed`);
          this.kill(proc, -1);
        }
        break;
      case 'irq': // no IRQ-raising devices in Phase 2; just resume
        this.ready(proc);
        break;
      case 'pagefault':
        this.log(
          `pid ${proc.pid} (${proc.name}): page fault @0x${r.vaddr.toString(16)} ` +
            `(${r.present ? 'protection' : 'not-present'}) -> killed`,
        );
        this.kill(proc, -1);
        break;
      case 'fault':
        this.log(`pid ${proc.pid} (${proc.name}): fault: ${r.message} -> killed`);
        this.kill(proc, -1);
        break;
      case 'halt': // user mode can't HLT (privileged); treat as exit if it happens
        this.kill(proc, 0);
        break;
    }
  }

  // --- syscall dispatch ---

  private handleSyscall(proc: Process): void {
    const regs = proc.cpu.regs;
    const num = regs[0]!; // R0 = syscall number

    switch (num) {
      case SYS.EXIT:
        this.log(`pid ${proc.pid} (${proc.name}): exit ${regs[1]! | 0}`);
        this.kill(proc, regs[1]! | 0);
        break;

      case SYS.WRITE: {
        regs[0] = this.sysWrite(proc, regs[1]!, regs[2]!, regs[3]!);
        this.ready(proc);
        break;
      }

      case SYS.YIELD:
        this.ready(proc);
        break;

      case SYS.GETPID:
        regs[0] = proc.pid;
        this.ready(proc);
        break;

      default:
        this.log(`pid ${proc.pid}: unknown syscall ${num}`);
        regs[0] = ERR;
        this.ready(proc);
        break;
    }
  }

  // write(fd, buf, len): copy bytes out of user space and emit to the console.
  private sysWrite(proc: Process, fd: number, buf: number, len: number): number {
    if (fd !== FD.STDOUT && fd !== FD.STDERR) return ERR;
    try {
      const data = this.vmm.copyin(proc.pd, buf, len);
      for (const b of data) this.ports.out(PORT.CONSOLE_DATA, b);
      return len;
    } catch (e) {
      if (e instanceof BadAddress) return ERR;
      throw e;
    }
  }

  // --- process state transitions ---

  private ready(proc: Process): void {
    proc.state = 'ready';
    this.readyQueue.push(proc);
  }

  private kill(proc: Process, code: number): void {
    proc.state = 'zombie';
    proc.exitCode = code | 0;
    // Not requeued. Kept in the table for the record (reaped by wait() in Phase 3).
  }
}
