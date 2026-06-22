// v2 CPU. Has physical memory + a paging MMU + port I/O + privilege levels.
//
// model A: the CPU runs user programs (guest bytecode) in USER mode, and when a
// trap / fault / interrupt happens run() returns control to the TS kernel, which
// inspects the state and resumes.

import { FLAG, type Mnemonic, OPCODE_TABLE, PRIVILEGED } from '../../isa.ts';
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

  readonly mmu: Mmu;
  readonly phys: PhysicalMemory;
  readonly ports: PortBus;
  private pendingIrq: number | null = null;

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
    this.pendingIrq = line;
  }

  // Clear CPU-local transient hardware state that is not part of a process trap
  // frame. Used by Machine.reset(), not by scheduler context switches.
  resetTransientState(): void {
    this.pendingIrq = null;
    this.pfla = 0;
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
      // Check for an interrupt at the instruction boundary (only when IF is set).
      if (this.pendingIrq !== null && this.getFlag(FLAG.IF)) {
        const line = this.pendingIrq;
        this.pendingIrq = null;
        return this.trap({ reason: 'irq', line });
      }
      // Snapshot enough to restart the instruction if it faults part-way. A page
      // fault (e.g. copy-on-write) must re-execute from the start, so the kernel
      // can resolve it and resume transparently.
      const pc0 = this.pc;
      const sp0 = this.sp;
      try {
        const result = this.step();
        if (result) return this.trap(result);
      } catch (e) {
        if (e instanceof PageFault) {
          this.pc = pc0; // restart the faulting instruction after the kernel fixes it
          this.sp = sp0;
          return this.trap({
            reason: 'pagefault',
            vaddr: e.vaddr,
            write: e.write,
            user: e.user,
            present: e.present,
          });
        }
        if (e instanceof CpuFault) {
          return this.trap({ reason: 'fault', kind: e.kind, message: e.message });
        }
        throw e;
      }
    }
    return this.trap({ reason: 'timer' });
  }

  // Funnel every run() exit through the trap hook so the trace sees it.
  private trap(r: RunResult): RunResult {
    this.onTrap?.(r);
    return r;
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
      case 'IRET':
        throw new CpuFault('illegal', 'IRET is not implemented (model B / Phase 8)');
      case 'HLT':
        return { reason: 'halt' };
    }
    return undefined;
  }
}
