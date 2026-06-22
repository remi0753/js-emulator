// v2 CPU. Has physical memory + a paging MMU + port I/O + privilege levels.
//
// model A: the CPU runs user programs (guest bytecode) in USER mode, and when a
// trap / fault / interrupt happens run() returns control to the TS kernel, which
// inspects the state and resumes. This is the default (IDTR == 0).
//
// model B (Phase 8): once a guest installs an interrupt descriptor table (LIDT),
// the CPU enters guest kernel mode in-CPU on a trap instead of returning to the
// host. It switches to the kernel stack (LKSP), pushes a trap frame, jumps to the
// vector's handler in KERNEL mode with interrupts disabled, and the handler
// returns with IRET. Software INT n, CPU exceptions, and device/timer IRQs all
// take the same vector path. If no IDT is installed (or the vector is absent),
// the CPU falls back to the model-A behaviour of returning to the host.

import {
  FLAG,
  IDT_ENTRY_SIZE,
  IDT_PRESENT,
  type Mnemonic,
  OPCODE_TABLE,
  PF_ERR,
  PRIVILEGED,
  TIMER_IRQ,
  TRAP,
} from '../../isa.ts';
import { type PhysicalMemory, WORD } from './memory.ts';
import { Mmu } from './mmu.ts';
import type { PortBus } from './ports.ts';

export const NUM_REGS = 8;

export const MODE = { KERNEL: 0, USER: 1 } as const;
export type Mode = (typeof MODE)[keyof typeof MODE];

export type FaultKind =
  | 'illegal-opcode'
  | 'divide-by-zero'
  | 'privileged' // privileged instruction in USER mode
  | 'illegal' // unimplemented instruction, etc.
  | 'phys-range'; // physical out-of-range while paging is off

// Why run() returns to JS (the kernel).
export type RunResult =
  | { reason: 'timer' } // quantum elapsed (PIT tick) -> preemption
  | { reason: 'syscall'; num: number } // INT n
  | { reason: 'pagefault'; vaddr: number; write: boolean; user: boolean; present: boolean }
  | { reason: 'fault'; kind: FaultKind; message: string }
  | { reason: 'halt' } // HLT (kernel mode / boot)
  | { reason: 'irq'; line: number }; // device interrupt

// The CPU's saveable state (equivalent to a process's trap frame).
export interface CpuState {
  regs: number[];
  pc: number;
  sp: number;
  flags: number;
  mode: Mode;
  ptbr: number;
  pagingEnabled: boolean;
}

// Exceptions used only inside the execution loop. run() converts them to trap results.
class PageFault {
  vaddr: number;
  write: boolean;
  user: boolean;
  present: boolean;
  constructor(vaddr: number, write: boolean, user: boolean, present: boolean) {
    this.vaddr = vaddr;
    this.write = write;
    this.user = user;
    this.present = present;
  }
}
class CpuFault {
  kind: FaultKind;
  message: string;
  constructor(kind: FaultKind, message: string) {
    this.kind = kind;
    this.message = message;
  }
}

export class CPU {
  regs: number[] = new Array(NUM_REGS).fill(0);
  pc = 0;
  sp = 0;
  flags = 0;
  mode: Mode = MODE.KERNEL;
  ptbr = 0; // page directory physical address (~CR3)
  pagingEnabled = false;
  pfla = 0; // page-fault linear address from the last fault (~CR2)

  // --- model-B trap-entry control registers ---
  idtr = 0; // physical base of the interrupt descriptor table; 0 = trap entry off
  ksp = 0; // kernel stack pointer (esp0) loaded on a USER->KERNEL trap
  errorCode = 0; // error code of the most recent trap (readable via RDERR)
  private timerInterval = 0; // in-CPU timer period in instructions; 0 = disabled
  private timerCount = 0; // instructions remaining until the next timer IRQ

  readonly mmu: Mmu;
  readonly phys: PhysicalMemory;
  readonly ports: PortBus;
  private pendingIrqs = new Set<number>();

  // Optional deterministic trace hooks (off by default; the Tracer wires them).
  // onTrace fires once per executed instruction; onTrap fires for every reason
  // run() returns to the host (syscall, fault, page fault, IRQ, halt, timer).
  onTrace: ((pc: number, mnemonic: Mnemonic) => void) | null = null;
  onTrap: ((result: RunResult) => void) | null = null;

  constructor(phys: PhysicalMemory, ports: PortBus) {
    this.phys = phys;
    this.ports = ports;
    this.mmu = new Mmu(phys);
  }

  // --- save / restore state ---

  loadState(s: CpuState): void {
    this.regs = s.regs;
    this.pc = s.pc;
    this.sp = s.sp;
    this.flags = s.flags;
    this.mode = s.mode;
    this.ptbr = s.ptbr;
    this.pagingEnabled = s.pagingEnabled;
  }

  saveState(s: CpuState): void {
    s.regs = this.regs;
    s.pc = this.pc;
    s.sp = this.sp;
    s.flags = this.flags;
    s.mode = this.mode;
    s.ptbr = this.ptbr;
    s.pagingEnabled = this.pagingEnabled;
  }

  // Interrupt request from a device. run() returns at the next instruction
  // boundary if IF is set.
  raiseIrq(line: number): void {
    this.pendingIrqs.add(line);
  }

  // Clear CPU-local transient hardware state that is not part of a process trap
  // frame. Used by Machine.reset(), not by scheduler context switches.
  resetTransientState(): void {
    this.pendingIrqs.clear();
    this.pfla = 0;
    this.idtr = 0;
    this.ksp = 0;
    this.errorCode = 0;
    this.timerInterval = 0;
    this.timerCount = 0;
  }

  // --- memory access with address translation ---

  private xlate(vaddr: number, write: boolean): number {
    if (!this.pagingEnabled) {
      if (vaddr < 0 || vaddr + 1 > this.phys.size) {
        throw new CpuFault('phys-range', `physical out of range: 0x${vaddr.toString(16)}`);
      }
      return vaddr;
    }
    const user = this.mode === MODE.USER;
    const r = this.mmu.translate(this.ptbr, vaddr, { write, user });
    if (!r.ok) {
      this.pfla = vaddr;
      throw new PageFault(vaddr, write, user, r.present);
    }
    return r.paddr;
  }

  private rd8(v: number): number {
    return this.phys.read8(this.xlate(v, false));
  }
  private wr8(v: number, x: number): void {
    this.phys.write8(this.xlate(v, true), x);
  }
  private rd32(v: number): number {
    const b0 = this.rd8(v);
    const b1 = this.rd8(v + 1);
    const b2 = this.rd8(v + 2);
    const b3 = this.rd8(v + 3);
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }
  private wr32(v: number, x: number): void {
    const u = x >>> 0;
    this.wr8(v, u & 0xff);
    this.wr8(v + 1, (u >>> 8) & 0xff);
    this.wr8(v + 2, (u >>> 16) & 0xff);
    this.wr8(v + 3, (u >>> 24) & 0xff);
  }

  // --- fetch (advances PC) ---

  private fetch8(): number {
    return this.rd8(this.pc++);
  }
  private fetch32(): number {
    const v = this.rd32(this.pc);
    this.pc += WORD;
    return v;
  }

  // --- flags / stack ---

  private setZS(result: number): number {
    const r = result >>> 0;
    this.setFlag(FLAG.ZF, r === 0);
    this.setFlag(FLAG.SF, (r & 0x80000000) !== 0);
    return r;
  }
  private setFlag(bit: number, on: boolean): void {
    if (on) this.flags |= bit;
    else this.flags &= ~bit;
  }
  private getFlag(bit: number): boolean {
    return (this.flags & bit) !== 0;
  }
  private push(value: number): void {
    this.sp -= WORD;
    this.wr32(this.sp, value);
  }
  private pop(): number {
    const v = this.rd32(this.sp);
    this.sp += WORD;
    return v;
  }

  // --- execution loop ---

  run(maxCycles: number): RunResult {
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      // Tick the in-CPU timer; on expiry post the timer IRQ (delivered below).
      if (this.timerInterval > 0 && --this.timerCount <= 0) {
        this.timerCount = this.timerInterval;
        this.raiseIrq(TIMER_IRQ);
      }

      // Check for an interrupt at the instruction boundary (only when IF is set).
      // The saved return address is the next instruction (this.pc).
      if (this.pendingIrqs.size > 0 && this.getFlag(FLAG.IF)) {
        const line = this.takePendingIrq();
        const deliver = this.deliver(TRAP.IRQ_BASE + line, this.pc, 0);
        if (deliver === 'host') return this.trap({ reason: 'irq', line });
        if (deliver === 'double') return this.trap(this.doubleFault());
        continue; // delivered to the guest handler in-CPU
      }

      // Snapshot enough to restart the instruction if it faults part-way. A page
      // fault (e.g. copy-on-write) must re-execute from the start, so the handler
      // can resolve it and resume transparently.
      const pc0 = this.pc;
      const sp0 = this.sp;
      try {
        const result = this.step();
        if (result) {
          // step() only returns for INT (syscall) and HLT. HLT always stops the
          // machine (the host execution boundary); a syscall vectors in-CPU when
          // an IDT is installed, else returns to the host.
          if (result.reason === 'syscall') {
            const deliver = this.deliver(result.num, this.pc, 0);
            if (deliver === 'host') return this.trap(result);
            if (deliver === 'double') return this.trap(this.doubleFault());
            continue;
          }
          return this.trap(result);
        }
      } catch (e) {
        if (e instanceof PageFault) {
          this.pc = pc0; // restart the faulting instruction after the handler fixes it
          this.sp = sp0;
          this.pfla = e.vaddr;
          const deliver = this.deliver(TRAP.PAGEFAULT, pc0, pfErrorCode(e));
          if (deliver === 'double') return this.trap(this.doubleFault());
          if (deliver === 'guest') continue;
          return this.trap({
            reason: 'pagefault',
            vaddr: e.vaddr,
            write: e.write,
            user: e.user,
            present: e.present,
          });
        }
        if (e instanceof CpuFault) {
          const deliver = this.deliver(faultVector(e.kind), pc0, 0);
          if (deliver === 'double') return this.trap(this.doubleFault());
          if (deliver === 'guest') continue;
          return this.trap({ reason: 'fault', kind: e.kind, message: e.message });
        }
        throw e;
      }
    }
    return this.trap({ reason: 'timer' });
  }

  private takePendingIrq(): number {
    const next = this.pendingIrqs.values().next();
    if (next.done) throw new Error('takePendingIrq called with no pending IRQ');
    this.pendingIrqs.delete(next.value);
    return next.value;
  }

  // Funnel every run() exit through the trap hook so the trace sees it.
  private trap(r: RunResult): RunResult {
    this.onTrap?.(r);
    return r;
  }

  // Deliver a trap to the guest in KERNEL mode by vectoring through the IDT.
  // Returns 'guest' if it entered the handler, 'host' if there is no IDT or the
  // vector is absent (fall back to model A), or 'double' if entry itself faulted.
  private deliver(
    vector: number,
    returnPc: number,
    errorCode: number,
  ): 'guest' | 'host' | 'double' {
    if (this.idtr === 0) return 'host';
    const base = this.idtr + vector * IDT_ENTRY_SIZE;
    let handler: number;
    let flags: number;
    try {
      handler = this.phys.read32(base);
      flags = this.phys.read32(base + 4);
    } catch (e) {
      if (e instanceof RangeError) return 'double';
      throw e;
    }
    if ((flags & IDT_PRESENT) === 0) return 'host';

    const oldMode = this.mode;
    const oldFlags = this.flags;
    const oldSp = this.sp;
    const oldErrorCode = this.errorCode;
    try {
      // Enter the kernel first so the frame pushes use supervisor translation,
      // then switch to the kernel stack on a privilege change (USER->KERNEL).
      this.mode = MODE.KERNEL;
      if (oldMode === MODE.USER) this.sp = this.ksp;
      this.errorCode = errorCode;
      this.push(oldSp); // trap frame: user sp / flags / mode / return pc
      this.push(oldFlags);
      this.push(oldMode);
      this.push(returnPc);
    } catch (e) {
      if (e instanceof PageFault || e instanceof CpuFault || e instanceof RangeError) {
        this.mode = oldMode;
        this.flags = oldFlags;
        this.sp = oldSp;
        this.errorCode = oldErrorCode;
        return 'double';
      }
      throw e;
    }
    this.setFlag(FLAG.IF, false); // mask interrupts on handler entry
    this.pc = handler;
    return 'guest';
  }

  private doubleFault(): RunResult {
    return { reason: 'fault', kind: 'illegal', message: 'double fault during trap delivery' };
  }

  private step(): RunResult | undefined {
    const ip = this.pc; // instruction address (for the trace), before fetch advances pc
    const opcode = this.fetch8();
    const entry = OPCODE_TABLE.get(opcode);
    if (!entry) throw new CpuFault('illegal-opcode', `illegal opcode: 0x${opcode.toString(16)}`);
    this.onTrace?.(ip, entry.mnemonic);

    // Trap if a privileged instruction is executed in USER mode.
    if (this.mode === MODE.USER && PRIVILEGED.has(entry.mnemonic)) {
      throw new CpuFault('privileged', `privileged instruction in USER mode: ${entry.mnemonic}`);
    }

    // Read operands in the order given by the spec table.
    const ops: number[] = [];
    for (const kind of entry.args) {
      if (kind === 'reg') {
        const r = this.fetch8();
        if (r >= NUM_REGS) throw new CpuFault('illegal', `invalid register number: ${r}`);
        ops.push(r);
      } else {
        ops.push(this.fetch32());
      }
    }

    const r = this.regs;
    switch (entry.mnemonic) {
      case 'NOP':
        break;
      case 'MOV':
        r[ops[0]!] = ops[1]! >>> 0;
        break;
      case 'MOVR':
        r[ops[0]!] = r[ops[1]!]!;
        break;
      case 'LOAD':
        r[ops[0]!] = this.rd32(ops[1]!);
        break;
      case 'STORE':
        this.wr32(ops[1]!, r[ops[0]!]!);
        break;
      case 'LOADR':
        r[ops[0]!] = this.rd32(r[ops[1]!]!);
        break;
      case 'STORER':
        this.wr32(r[ops[0]!]!, r[ops[1]!]!);
        break;
      case 'LB':
        r[ops[0]!] = this.rd8(r[ops[1]!]!);
        break;
      case 'SB':
        this.wr8(r[ops[0]!]!, r[ops[1]!]! & 0xff);
        break;

      case 'ADD': {
        const sum = r[ops[0]!]! + r[ops[1]!]!;
        this.setFlag(FLAG.CF, sum > 0xffffffff);
        r[ops[0]!] = this.setZS(sum);
        break;
      }
      case 'SUB': {
        const a = r[ops[0]!]!;
        const b = r[ops[1]!]!;
        this.setFlag(FLAG.CF, a < b);
        r[ops[0]!] = this.setZS(a - b);
        break;
      }
      case 'MUL':
        r[ops[0]!] = this.setZS(Math.imul(r[ops[0]!]!, r[ops[1]!]!));
        break;
      case 'DIV': {
        const b = r[ops[1]!]!;
        if (b === 0) throw new CpuFault('divide-by-zero', 'divide by zero');
        r[ops[0]!] = this.setZS(Math.floor(r[ops[0]!]! / b));
        break;
      }
      case 'MOD': {
        const b = r[ops[1]!]!;
        if (b === 0) throw new CpuFault('divide-by-zero', 'divide by zero (MOD)');
        r[ops[0]!] = this.setZS(r[ops[0]!]! % b);
        break;
      }
      case 'AND':
        r[ops[0]!] = this.setZS(r[ops[0]!]! & r[ops[1]!]!);
        break;
      case 'OR':
        r[ops[0]!] = this.setZS(r[ops[0]!]! | r[ops[1]!]!);
        break;
      case 'XOR':
        r[ops[0]!] = this.setZS(r[ops[0]!]! ^ r[ops[1]!]!);
        break;
      case 'NOT':
        r[ops[0]!] = this.setZS(~r[ops[0]!]!);
        break;
      case 'SHL':
        r[ops[0]!] = this.setZS(r[ops[0]!]! << (r[ops[1]!]! & 31));
        break;
      case 'SHR':
        r[ops[0]!] = this.setZS(r[ops[0]!]! >>> (r[ops[1]!]! & 31));
        break;
      case 'INC':
        r[ops[0]!] = this.setZS(r[ops[0]!]! + 1);
        break;
      case 'DEC':
        r[ops[0]!] = this.setZS(r[ops[0]!]! - 1);
        break;
      case 'CMP': {
        const a = r[ops[0]!]!;
        const b = r[ops[1]!]!;
        this.setFlag(FLAG.CF, a < b);
        this.setZS(a - b);
        break;
      }

      case 'JMP':
        this.pc = ops[0]!;
        break;
      case 'JZ':
        if (this.getFlag(FLAG.ZF)) this.pc = ops[0]!;
        break;
      case 'JNZ':
        if (!this.getFlag(FLAG.ZF)) this.pc = ops[0]!;
        break;
      case 'JG':
        if (!this.getFlag(FLAG.ZF) && !this.getFlag(FLAG.SF)) this.pc = ops[0]!;
        break;
      case 'JGE':
        if (!this.getFlag(FLAG.SF)) this.pc = ops[0]!;
        break;
      case 'JL':
        if (this.getFlag(FLAG.SF)) this.pc = ops[0]!;
        break;
      case 'JLE':
        if (this.getFlag(FLAG.SF) || this.getFlag(FLAG.ZF)) this.pc = ops[0]!;
        break;
      case 'CALL':
        this.push(this.pc);
        this.pc = ops[0]!;
        break;
      case 'RET':
        this.pc = this.pop();
        break;

      case 'PUSH':
        this.push(r[ops[0]!]!);
        break;
      case 'POP':
        r[ops[0]!] = this.pop();
        break;

      // --- system ---
      case 'INT':
        return { reason: 'syscall', num: ops[0]! >>> 0 };
      case 'EI':
        this.setFlag(FLAG.IF, true);
        break;
      case 'DI':
        this.setFlag(FLAG.IF, false);
        break;
      case 'IN': // rd = port[rp]
        r[ops[0]!] = this.ports.in(r[ops[1]!]!) >>> 0;
        break;
      case 'OUT': // port[rp] = rs   (operands: rp, rs)
        this.ports.out(r[ops[0]!]!, r[ops[1]!]!);
        break;
      case 'IRET': {
        // Pop the trap frame pushed by deliver() (all reads while still KERNEL).
        const pc = this.pop();
        const mode = this.pop();
        const flags = this.pop();
        const sp = this.pop();
        this.pc = pc;
        this.flags = flags;
        this.mode = mode === MODE.USER ? MODE.USER : MODE.KERNEL;
        this.sp = sp; // restore the (user or nested-kernel) stack pointer
        break;
      }
      case 'LIDT':
        this.idtr = r[ops[0]!]! >>> 0;
        break;
      case 'LKSP':
        this.ksp = r[ops[0]!]! >>> 0;
        break;
      case 'RDPFLA':
        r[ops[0]!] = this.pfla >>> 0;
        break;
      case 'RDERR':
        r[ops[0]!] = this.errorCode >>> 0;
        break;
      case 'STMR': {
        const n = r[ops[0]!]! >>> 0;
        this.timerInterval = n;
        this.timerCount = n;
        break;
      }
      case 'LPTBR':
        this.ptbr = r[ops[0]!]! >>> 0;
        break;
      case 'PGON':
        this.pagingEnabled = true;
        break;
      case 'PGOFF':
        this.pagingEnabled = false;
        break;
      case 'HLT':
        return { reason: 'halt' };
    }
    return undefined;
  }
}

// Map a CPU exception to its trap vector (model B in-CPU delivery).
function faultVector(kind: FaultKind): number {
  switch (kind) {
    case 'divide-by-zero':
      return TRAP.DIVZERO;
    case 'illegal-opcode':
    case 'illegal':
      return TRAP.ILLOP;
    default: // privileged, phys-range
      return TRAP.GP;
  }
}

// Pack a page fault into an x86-like error code (readable by the handler via RDERR).
function pfErrorCode(e: PageFault): number {
  return (
    (e.present ? PF_ERR.PRESENT : 0) | (e.write ? PF_ERR.WRITE : 0) | (e.user ? PF_ERR.USER : 0)
  );
}
