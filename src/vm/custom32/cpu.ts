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
  type ArgKind,
  FLAG,
  IDT_ENTRY_SIZE,
  IDT_PRESENT,
  IDT_USER,
  type Mnemonic,
  OPCODE_TABLE,
  PF_ERR,
  PRIVILEGED,
  TIMER_IRQ,
  TRAP,
} from '../../isa.ts';
import { PAGE_SIZE, type PhysicalMemory, WORD } from './memory.ts';
import { Mmu } from './mmu.ts';
import type { PortBus } from './ports.ts';

export const NUM_REGS = 8;

export const MODE = { KERNEL: 0, USER: 1 } as const;
export type Mode = (typeof MODE)[keyof typeof MODE];

const ARG_NONE = 0;
const ARG_REG = 1;
const ARG_WORD = 2;

// Software TLB: direct-mapped, indexed by the low bits of the virtual page number.
const TLB_ENTRIES = 1 << 12;
const TLB_MASK = TLB_ENTRIES - 1;

interface DecodedOpcode {
  mnemonic: Mnemonic;
  arg0: typeof ARG_NONE | typeof ARG_REG | typeof ARG_WORD;
  arg1: typeof ARG_NONE | typeof ARG_REG | typeof ARG_WORD;
  privileged: boolean;
}

const OPCODES: (DecodedOpcode | undefined)[] = (() => {
  const table: (DecodedOpcode | undefined)[] = [];
  for (const [opcode, entry] of OPCODE_TABLE) {
    const [arg0, arg1] = entry.args;
    table[opcode] = {
      mnemonic: entry.mnemonic,
      arg0: decodeArgKind(arg0),
      arg1: decodeArgKind(arg1),
      privileged: PRIVILEGED.has(entry.mnemonic),
    };
  }
  return table;
})();

function decodeArgKind(
  kind: ArgKind | undefined,
): typeof ARG_NONE | typeof ARG_REG | typeof ARG_WORD {
  if (kind === undefined) return ARG_NONE;
  return kind === 'reg' ? ARG_REG : ARG_WORD;
}

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
  private poweredOff = false; // a power device asserted power-off; run() stops

  readonly mmu: Mmu;
  readonly phys: PhysicalMemory;
  readonly ports: PortBus;
  private pendingIrqMask = 0;
  private pendingIrqOrder: number[] = [];

  // Software TLB caching virtual-page -> physical-frame translations, refilled by
  // xlateN on a miss. Flushed on any address-space change (ptbr load, paging
  // toggle, reset) and on page-fault delivery, since the handler may edit PTEs in
  // place (e.g. copy-on-write). Misses (faults) are never cached.
  private readonly tlbTag = new Int32Array(TLB_ENTRIES).fill(-1);
  private readonly tlbFrame = new Int32Array(TLB_ENTRIES);
  private readonly tlbWrite = new Uint8Array(TLB_ENTRIES);
  private readonly tlbUser = new Uint8Array(TLB_ENTRIES);

  // Code-page cache for instruction fetch: the virtual page (or -1) and physical
  // base of the page currently executing, so fetch8/fetch32 skip translation
  // while PC stays in the page. Invalidated with the TLB and on mode changes.
  private fetchVpn = -1;
  private fetchBase = 0;

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
    this.flushTlb(); // the address space may have changed
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
    const bit = 1 << line;
    if ((this.pendingIrqMask & bit) !== 0) return;
    this.pendingIrqMask |= bit;
    this.pendingIrqOrder.push(line);
  }

  // Assert the power-off line (a power device calls this). run() stops at the
  // next instruction boundary and reports a halt, like a HLT.
  powerOff(): void {
    this.poweredOff = true;
  }

  // Clear CPU-local transient hardware state that is not part of a process trap
  // frame. Used by Machine.reset(), not by scheduler context switches.
  resetTransientState(): void {
    this.pendingIrqMask = 0;
    this.pendingIrqOrder.length = 0;
    this.pfla = 0;
    this.idtr = 0;
    this.ksp = 0;
    this.errorCode = 0;
    this.timerInterval = 0;
    this.timerCount = 0;
    this.poweredOff = false;
    this.flushTlb();
  }

  // --- memory access with address translation ---

  private xlateN(vaddr: number, bytes: number, write: boolean): number {
    if (!this.pagingEnabled) {
      if (vaddr < 0 || vaddr + bytes > this.phys.size) {
        throw new CpuFault('phys-range', `physical out of range: 0x${vaddr.toString(16)}`);
      }
      return vaddr;
    }
    const vpn = vaddr >>> 12;
    const idx = vpn & TLB_MASK;
    const user = this.mode === MODE.USER;
    if (this.tlbTag[idx] === vpn) {
      // Hit: serve directly if this access is permitted. A permission mismatch
      // (e.g. a write to a cached read-only page) falls through to a full walk so
      // the proper protection fault is raised.
      if ((!user || this.tlbUser[idx] !== 0) && (!write || this.tlbWrite[idx] !== 0)) {
        return this.tlbFrame[idx]! + (vaddr & 0xfff);
      }
    }
    const r = this.mmu.translate(this.ptbr, vaddr, { write, user });
    if (!r.ok) {
      this.pfla = vaddr;
      throw new PageFault(vaddr, write, user, r.present);
    }
    this.tlbTag[idx] = vpn;
    this.tlbFrame[idx] = r.frame;
    this.tlbWrite[idx] = r.writable ? 1 : 0;
    this.tlbUser[idx] = r.user ? 1 : 0;
    return r.paddr;
  }

  private flushTlb(): void {
    this.tlbTag.fill(-1);
    this.fetchVpn = -1;
  }

  private rd8(v: number): number {
    const p = this.xlateN(v, 1, false);
    if (p >= this.phys.size)
      throw new RangeError(`physical memory out of range: 0x${p.toString(16)} (+1)`);
    return this.phys.bytes[p]!;
  }
  private wr8(v: number, x: number): void {
    const p = this.xlateN(v, 1, true);
    if (p >= this.phys.size)
      throw new RangeError(`physical memory out of range: 0x${p.toString(16)} (+1)`);
    this.phys.bytes[p] = x & 0xff;
  }
  private rd32(v: number): number {
    if ((v & 0xfff) <= 0xffc) {
      const p = this.xlateN(v, 4, false);
      if (p + 4 > this.phys.size) {
        throw new RangeError(`physical memory out of range: 0x${p.toString(16)} (+4)`);
      }
      const b = this.phys.bytes;
      return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
    }
    const b0 = this.rd8(v);
    const b1 = this.rd8(v + 1);
    const b2 = this.rd8(v + 2);
    const b3 = this.rd8(v + 3);
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }
  private rd16(v: number): number {
    if ((v & 0xfff) <= 0xffe) {
      const p = this.xlateN(v, 2, false);
      if (p + 2 > this.phys.size) {
        throw new RangeError(`physical memory out of range: 0x${p.toString(16)} (+2)`);
      }
      const b = this.phys.bytes;
      return (b[p]! | (b[p + 1]! << 8)) >>> 0;
    }
    const b0 = this.rd8(v);
    const b1 = this.rd8(v + 1);
    return (b0 | (b1 << 8)) >>> 0;
  }
  private wr32(v: number, x: number): void {
    if ((v & 0xfff) <= 0xffc) {
      const p = this.xlateN(v, 4, true);
      if (p + 4 > this.phys.size) {
        throw new RangeError(`physical memory out of range: 0x${p.toString(16)} (+4)`);
      }
      const u = x >>> 0;
      const b = this.phys.bytes;
      b[p] = u & 0xff;
      b[p + 1] = (u >>> 8) & 0xff;
      b[p + 2] = (u >>> 16) & 0xff;
      b[p + 3] = (u >>> 24) & 0xff;
      return;
    }
    const u = x >>> 0;
    this.wr8(v, u & 0xff);
    this.wr8(v + 1, (u >>> 8) & 0xff);
    this.wr8(v + 2, (u >>> 16) & 0xff);
    this.wr8(v + 3, (u >>> 24) & 0xff);
  }
  private wr16(v: number, x: number): void {
    if ((v & 0xfff) <= 0xffe) {
      const p = this.xlateN(v, 2, true);
      if (p + 2 > this.phys.size) {
        throw new RangeError(`physical memory out of range: 0x${p.toString(16)} (+2)`);
      }
      const u = x >>> 0;
      const b = this.phys.bytes;
      b[p] = u & 0xff;
      b[p + 1] = (u >>> 8) & 0xff;
      return;
    }
    const u = x >>> 0;
    this.wr8(v, u & 0xff);
    this.wr8(v + 1, (u >>> 8) & 0xff);
  }

  // --- fetch (advances PC) ---

  private fetch8(): number {
    const pc = this.pc;
    if (pc >>> 12 === this.fetchVpn) {
      this.pc = pc + 1;
      return this.phys.bytes[this.fetchBase + (pc & 0xfff)]!;
    }
    return this.fetchByteSlow(pc);
  }
  private fetch32(): number {
    const pc = this.pc;
    const off = pc & 0xfff;
    if (off <= 0xffc && pc >>> 12 === this.fetchVpn) {
      const b = this.phys.bytes;
      const p = this.fetchBase + off;
      this.pc = pc + WORD;
      return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
    }
    const v = this.rd32(pc); // cross-page or cold operand: go through the TLB path
    this.pc = pc + WORD;
    return v;
  }
  // fetch8 miss: refill the code-page cache when paging maps a whole in-range
  // frame, else fall back to the checked byte read (boot/non-paging, edge frames).
  private fetchByteSlow(pc: number): number {
    if (this.pagingEnabled) {
      const p = this.xlateN(pc, 1, false);
      const base = p - (pc & 0xfff);
      if (base >= 0 && base + PAGE_SIZE <= this.phys.size) {
        this.fetchVpn = pc >>> 12;
        this.fetchBase = base;
        this.pc = pc + 1;
        return this.phys.bytes[p]!;
      }
    }
    this.pc = pc + 1;
    return this.rd8(pc);
  }

  // --- flags / stack ---

  private setZS(result: number): number {
    const r = result >>> 0;
    let flags = this.flags & ~(FLAG.ZF | FLAG.SF);
    if (r === 0) flags |= FLAG.ZF;
    if ((r & 0x80000000) !== 0) flags |= FLAG.SF;
    this.flags = flags;
    return r;
  }
  private setAddFlags(a: number, b: number, result: number): number {
    const r = result >>> 0;
    let flags = this.flags & ~(FLAG.ZF | FLAG.SF | FLAG.CF | FLAG.OF);
    if (r === 0) flags |= FLAG.ZF;
    if ((r & 0x80000000) !== 0) flags |= FLAG.SF;
    if ((a >>> 0) + (b >>> 0) > 0xffffffff) flags |= FLAG.CF;
    if ((~(a ^ b) & (a ^ r) & 0x80000000) !== 0) flags |= FLAG.OF;
    this.flags = flags;
    return r;
  }
  private setSubFlags(a: number, b: number, result: number): number {
    const r = result >>> 0;
    let flags = this.flags & ~(FLAG.ZF | FLAG.SF | FLAG.CF | FLAG.OF);
    if (r === 0) flags |= FLAG.ZF;
    if ((r & 0x80000000) !== 0) flags |= FLAG.SF;
    if (a >>> 0 < b >>> 0) flags |= FLAG.CF;
    if (((a ^ b) & (a ^ r) & 0x80000000) !== 0) flags |= FLAG.OF;
    this.flags = flags;
    return r;
  }
  private signedLess(): boolean {
    const flags = this.flags;
    return ((flags & FLAG.SF) !== 0) !== ((flags & FLAG.OF) !== 0);
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
      // A power device asserted power-off (e.g. via an OUT in the previous step):
      // stop the machine cleanly before executing any further instruction.
      if (this.poweredOff) return this.trap({ reason: 'halt' });

      // Tick the in-CPU timer; on expiry post the timer IRQ (delivered below).
      if (this.timerInterval > 0 && --this.timerCount <= 0) {
        this.timerCount = this.timerInterval;
        this.raiseIrq(TIMER_IRQ);
      }

      // Check for an interrupt at the instruction boundary (only when IF is set).
      // The saved return address is the next instruction (this.pc).
      if (this.pendingIrqMask !== 0 && (this.flags & FLAG.IF) !== 0) {
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
            const deliver = this.deliver(result.num, this.pc, 0, true);
            if (deliver === 'denied') {
              const gp = this.deliver(TRAP.GP, pc0, 0);
              if (gp === 'double') return this.trap(this.doubleFault());
              if (gp === 'guest') continue;
              return this.trap({
                reason: 'fault',
                kind: 'privileged',
                message: `software interrupt 0x${result.num.toString(16)} is not callable from USER mode`,
              });
            }
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
          this.flushTlb(); // the handler may remap pages in place (e.g. copy-on-write)
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
    const line = this.pendingIrqOrder.shift();
    if (line === undefined) throw new Error('takePendingIrq called with no pending IRQ');
    this.pendingIrqMask &= ~(1 << line);
    return line;
  }

  private cancelPendingIrq(line: number): void {
    const bit = 1 << line;
    if ((this.pendingIrqMask & bit) === 0) return;
    this.pendingIrqMask &= ~bit;
    const index = this.pendingIrqOrder.indexOf(line);
    if (index >= 0) this.pendingIrqOrder.splice(index, 1);
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
    software = false,
  ): 'guest' | 'host' | 'double' | 'denied' {
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
    if (software && this.mode === MODE.USER && (flags & IDT_USER) === 0) return 'denied';

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
    this.flags &= ~FLAG.IF; // mask interrupts on handler entry
    this.pc = handler;
    this.fetchVpn = -1; // mode changed to KERNEL: re-validate the code page
    return 'guest';
  }

  private doubleFault(): RunResult {
    return { reason: 'fault', kind: 'illegal', message: 'double fault during trap delivery' };
  }

  private step(): RunResult | undefined {
    const ip = this.pc; // instruction address (for the trace), before fetch advances pc
    let opcode: number;
    let op0 = 0;
    let op1 = 0;

    // Fast path: the whole instruction (opcode + up to two operands, <= 9 bytes)
    // lies within the cached code page, so decode it straight from phys.bytes with
    // no per-byte fetch call. The page is mode-validated when it was cached (see
    // fetchByteSlow / flushTlb), so a hit needs no re-check. Anything that could
    // cross a page boundary takes the checked-fetch path below.
    const off = ip & 0xfff;
    if (ip >>> 12 === this.fetchVpn && off <= 0xff7) {
      const b = this.phys.bytes;
      const start = this.fetchBase + off;
      let c = start;
      opcode = b[c++]!;
      const entry = OPCODES[opcode];
      if (entry === undefined) {
        throw new CpuFault('illegal-opcode', `illegal opcode: 0x${opcode.toString(16)}`);
      }
      if (this.onTrace) this.onTrace(ip, entry.mnemonic);
      if (this.mode === MODE.USER && entry.privileged) {
        throw new CpuFault('privileged', `privileged instruction in USER mode: ${entry.mnemonic}`);
      }
      if (entry.arg0 === ARG_REG) {
        op0 = b[c++]!;
        if (op0 >= NUM_REGS) throw new CpuFault('illegal', `invalid register number: ${op0}`);
      } else if (entry.arg0 === ARG_WORD) {
        op0 = (b[c]! | (b[c + 1]! << 8) | (b[c + 2]! << 16) | (b[c + 3]! << 24)) >>> 0;
        c += 4;
      }
      if (entry.arg1 === ARG_REG) {
        op1 = b[c++]!;
        if (op1 >= NUM_REGS) throw new CpuFault('illegal', `invalid register number: ${op1}`);
      } else if (entry.arg1 === ARG_WORD) {
        op1 = (b[c]! | (b[c + 1]! << 8) | (b[c + 2]! << 16) | (b[c + 3]! << 24)) >>> 0;
        c += 4;
      }
      this.pc = ip + (c - start);
    } else {
      opcode = this.fetch8();
      const entry = OPCODES[opcode];
      if (entry === undefined) {
        throw new CpuFault('illegal-opcode', `illegal opcode: 0x${opcode.toString(16)}`);
      }
      if (this.onTrace) this.onTrace(ip, entry.mnemonic);
      if (this.mode === MODE.USER && entry.privileged) {
        throw new CpuFault('privileged', `privileged instruction in USER mode: ${entry.mnemonic}`);
      }
      // Read operands in the order given by the spec table.
      if (entry.arg0 === ARG_REG) {
        op0 = this.fetch8();
        if (op0 >= NUM_REGS) throw new CpuFault('illegal', `invalid register number: ${op0}`);
      } else if (entry.arg0 === ARG_WORD) {
        op0 = this.fetch32();
      }
      if (entry.arg1 === ARG_REG) {
        op1 = this.fetch8();
        if (op1 >= NUM_REGS) throw new CpuFault('illegal', `invalid register number: ${op1}`);
      } else if (entry.arg1 === ARG_WORD) {
        op1 = this.fetch32();
      }
    }

    const r = this.regs;
    switch (opcode) {
      case 0x00 /* NOP */:
        break;
      case 0x01 /* MOV */:
        r[op0] = op1 >>> 0;
        break;
      case 0x02 /* MOVR */:
        r[op0] = r[op1]!;
        break;
      case 0x03 /* LOAD */:
        r[op0] = this.rd32(op1);
        break;
      case 0x04 /* STORE */:
        this.wr32(op1, r[op0]!);
        break;
      case 0x05 /* LOADR */:
        r[op0] = this.rd32(r[op1]!);
        break;
      case 0x06 /* STORER */:
        this.wr32(r[op0]!, r[op1]!);
        break;
      case 0x07 /* LB */:
        r[op0] = this.rd8(r[op1]!);
        break;
      case 0x08 /* SB */:
        this.wr8(r[op0]!, r[op1]! & 0xff);
        break;
      case 0x09: /* LBS */ {
        const v = this.rd8(r[op1]!);
        r[op0] = (v & 0x80) !== 0 ? (v | 0xffffff00) >>> 0 : v;
        break;
      }
      case 0x0a /* LH */:
        r[op0] = this.rd16(r[op1]!);
        break;
      case 0x0b: /* LHS */ {
        const v = this.rd16(r[op1]!);
        r[op0] = (v & 0x8000) !== 0 ? (v | 0xffff0000) >>> 0 : v;
        break;
      }
      case 0x0c /* SH */:
        this.wr16(r[op0]!, r[op1]! & 0xffff);
        break;

      case 0x10: /* ADD */ {
        const a = r[op0]!;
        const b = r[op1]!;
        r[op0] = this.setAddFlags(a, b, a + b);
        break;
      }
      case 0x11: /* SUB */ {
        const a = r[op0]!;
        const b = r[op1]!;
        r[op0] = this.setSubFlags(a, b, a - b);
        break;
      }
      case 0x12 /* MUL */:
        r[op0] = this.setZS(Math.imul(r[op0]!, r[op1]!));
        break;
      case 0x13: /* DIV */ {
        const b = r[op1]!;
        if (b === 0) throw new CpuFault('divide-by-zero', 'divide by zero');
        r[op0] = this.setZS(Math.floor(r[op0]! / b));
        break;
      }
      case 0x14: /* MOD */ {
        const b = r[op1]!;
        if (b === 0) throw new CpuFault('divide-by-zero', 'divide by zero (MOD)');
        r[op0] = this.setZS(r[op0]! % b);
        break;
      }
      case 0x1e: /* IDIV */ {
        const b = r[op1]! | 0;
        if (b === 0) throw new CpuFault('divide-by-zero', 'divide by zero');
        r[op0] = this.setZS(Math.trunc((r[op0]! | 0) / b));
        break;
      }
      case 0x1f: /* IMOD */ {
        const b = r[op1]! | 0;
        if (b === 0) throw new CpuFault('divide-by-zero', 'divide by zero (IMOD)');
        r[op0] = this.setZS((r[op0]! | 0) % b);
        break;
      }
      case 0x15 /* AND */:
        r[op0] = this.setZS(r[op0]! & r[op1]!);
        break;
      case 0x16 /* OR */:
        r[op0] = this.setZS(r[op0]! | r[op1]!);
        break;
      case 0x17 /* XOR */:
        r[op0] = this.setZS(r[op0]! ^ r[op1]!);
        break;
      case 0x18 /* NOT */:
        r[op0] = this.setZS(~r[op0]!);
        break;
      case 0x19 /* SHL */:
        r[op0] = this.setZS(r[op0]! << (r[op1]! & 31));
        break;
      case 0x1a /* SHR */:
        r[op0] = this.setZS(r[op0]! >>> (r[op1]! & 31));
        break;
      case 0x2e /* SAR */:
        r[op0] = this.setZS((r[op0]! | 0) >> (r[op1]! & 31));
        break;
      case 0x1b /* INC */:
        r[op0] = this.setAddFlags(r[op0]!, 1, r[op0]! + 1);
        break;
      case 0x1c /* DEC */:
        r[op0] = this.setSubFlags(r[op0]!, 1, r[op0]! - 1);
        break;
      case 0x1d: /* CMP */ {
        const a = r[op0]!;
        const b = r[op1]!;
        this.setSubFlags(a, b, a - b);
        break;
      }

      case 0x20 /* JMP */:
        this.pc = op0;
        break;
      case 0x21 /* JZ */:
        if ((this.flags & FLAG.ZF) !== 0) this.pc = op0;
        break;
      case 0x22 /* JNZ */:
        if ((this.flags & FLAG.ZF) === 0) this.pc = op0;
        break;
      case 0x23 /* JG */:
        if ((this.flags & FLAG.ZF) === 0 && !this.signedLess()) this.pc = op0;
        break;
      case 0x24 /* JGE */:
        if (!this.signedLess()) this.pc = op0;
        break;
      case 0x25 /* JL */:
        if (this.signedLess()) this.pc = op0;
        break;
      case 0x26 /* JLE */:
        if (this.signedLess() || (this.flags & FLAG.ZF) !== 0) this.pc = op0;
        break;
      case 0x27 /* CALL */:
        this.push(this.pc);
        this.pc = op0;
        break;
      case 0x29 /* CALLR */:
        this.push(this.pc);
        this.pc = r[op0]! >>> 0;
        break;
      case 0x2a /* JA */:
        if ((this.flags & (FLAG.CF | FLAG.ZF)) === 0) this.pc = op0;
        break;
      case 0x2b /* JAE */:
        if ((this.flags & FLAG.CF) === 0) this.pc = op0;
        break;
      case 0x2c /* JB */:
        if ((this.flags & FLAG.CF) !== 0) this.pc = op0;
        break;
      case 0x2d /* JBE */:
        if ((this.flags & (FLAG.CF | FLAG.ZF)) !== 0) this.pc = op0;
        break;
      case 0x28 /* RET */:
        this.pc = this.pop();
        break;

      case 0x30 /* PUSH */:
        this.push(r[op0]!);
        break;
      case 0x31 /* POP */:
        r[op0] = this.pop();
        break;

      // --- system ---
      case 0x40 /* INT */:
        return { reason: 'syscall', num: op0 >>> 0 };
      case 0x41 /* EI */:
        this.flags |= FLAG.IF;
        break;
      case 0x42 /* DI */:
        this.flags &= ~FLAG.IF;
        break;
      case 0x43 /* IN */: // rd = port[rp]
        r[op0] = this.ports.in(r[op1]!) >>> 0;
        break;
      case 0x44 /* OUT */: // port[rp] = rs   (operands: rp, rs)
        this.ports.out(r[op0]!, r[op1]!);
        break;
      case 0x45: /* IRET */ {
        // Pop the trap frame pushed by deliver() (all reads while still KERNEL).
        const pc = this.pop();
        const mode = this.pop();
        const flags = this.pop();
        const sp = this.pop();
        this.pc = pc;
        this.flags = flags;
        this.mode = mode === MODE.USER ? MODE.USER : MODE.KERNEL;
        this.sp = sp; // restore the (user or nested-kernel) stack pointer
        this.fetchVpn = -1; // mode may have changed: re-validate the code page
        break;
      }
      case 0x46 /* LIDT */:
        this.idtr = r[op0]! >>> 0;
        break;
      case 0x47 /* LKSP */:
        this.ksp = r[op0]! >>> 0;
        break;
      case 0x48 /* RDPFLA */:
        r[op0] = this.pfla >>> 0;
        break;
      case 0x49 /* RDERR */:
        r[op0] = this.errorCode >>> 0;
        break;
      case 0x4a: /* STMR */ {
        const n = r[op0]! >>> 0;
        this.timerInterval = n;
        this.timerCount = n;
        if (n === 0) this.cancelPendingIrq(TIMER_IRQ);
        break;
      }
      case 0x4b /* LPTBR */:
        this.ptbr = r[op0]! >>> 0;
        this.flushTlb();
        break;
      case 0x4c /* PGON */:
        this.pagingEnabled = true;
        this.flushTlb();
        break;
      case 0x4d /* PGOFF */:
        this.pagingEnabled = false;
        this.flushTlb();
        break;
      case 0xff /* HLT */:
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
