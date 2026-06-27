// Virtual register-machine CPU (v1).
//
// Core idea: run(maxCycles) executes up to maxCycles instructions, and returns
// to JS the moment an INT / HLT / fault happens. That return stands in for a
// hardware timer interrupt and lets the OS (in JS) drive preemption.

import { type ArgKind, FLAG, OPCODE_TABLE } from '../isa.ts';

export const MEM_SIZE = 64 * 1024; // 64 KiB
export const NUM_REGS = 8; // R0-R7
export const WORD = 4; // 32-bit word

// Why run() returned to JS. Discriminated union.
export type RunResult =
  | { reason: 'quantum' }
  | { reason: 'int'; int: number }
  | { reason: 'halt' }
  | { reason: 'fault'; message: string };

// A process's execution state (the v1 context).
export interface Context {
  regs: number[]; // R0-R7 (length 8)
  pc: number;
  sp: number;
  flags: number;
  mem: Uint8Array; // v1: a dedicated per-process memory image
}

// Internal exception for an illegal execution. Used only inside run()'s loop and
// converted into a fault result.
class CpuFault extends Error {}

export class CPU {
  regs: number[] = new Array(NUM_REGS).fill(0);
  pc = 0;
  sp = MEM_SIZE; // downward-growing stack; the first PUSH does SP -= 4.
  flags = 0;
  mem: Uint8Array = new Uint8Array(MEM_SIZE);

  // --- context operations ---

  loadContext(ctx: Context): void {
    this.regs = ctx.regs;
    this.pc = ctx.pc;
    this.sp = ctx.sp;
    this.flags = ctx.flags;
    this.mem = ctx.mem; // swap the reference (v1 gives each process its own memory)
  }

  saveContext(ctx: Context): void {
    // regs / mem are shared by reference, so only the scalars need writing back.
    ctx.pc = this.pc;
    ctx.sp = this.sp;
    ctx.flags = this.flags;
  }

  // --- memory access (little-endian 32-bit) ---

  private read32(addr: number): number {
    if (addr < 0 || addr + WORD > MEM_SIZE) {
      throw new CpuFault(`memory read out of range: 0x${addr.toString(16)}`);
    }
    const m = this.mem;
    return (m[addr]! | (m[addr + 1]! << 8) | (m[addr + 2]! << 16) | (m[addr + 3]! << 24)) >>> 0;
  }

  private write32(addr: number, value: number): void {
    if (addr < 0 || addr + WORD > MEM_SIZE) {
      throw new CpuFault(`memory write out of range: 0x${addr.toString(16)}`);
    }
    const v = value >>> 0;
    const m = this.mem;
    m[addr] = v & 0xff;
    m[addr + 1] = (v >>> 8) & 0xff;
    m[addr + 2] = (v >>> 16) & 0xff;
    m[addr + 3] = (v >>> 24) & 0xff;
  }

  // --- instruction fetch (advances PC) ---

  private fetchU8(): number {
    if (this.pc < 0 || this.pc >= MEM_SIZE) {
      throw new CpuFault(`instruction fetch out of range: PC=0x${this.pc.toString(16)}`);
    }
    return this.mem[this.pc++]!;
  }

  private fetchU32(): number {
    const v = this.read32(this.pc);
    this.pc += WORD;
    return v;
  }

  private fetchOperand(kind: ArgKind): number {
    if (kind === 'reg') {
      const r = this.fetchU8();
      if (r >= NUM_REGS) throw new CpuFault(`invalid register number: ${r}`);
      return r;
    }
    // imm / addr are both 4 bytes
    return this.fetchU32();
  }

  // --- flag updates ---

  // Update ZF/SF from an arithmetic/logic result (CF/OF are handled by callers).
  private setZS(result: number): number {
    const r = result >>> 0;
    this.setFlag(FLAG.ZF, r === 0);
    this.setFlag(FLAG.SF, (r & 0x80000000) !== 0);
    return r;
  }

  private setAddFlags(a: number, b: number, result: number): number {
    const r = this.setZS(result);
    this.setFlag(FLAG.CF, (a >>> 0) + (b >>> 0) > 0xffffffff);
    this.setFlag(FLAG.OF, (~(a ^ b) & (a ^ r) & 0x80000000) !== 0);
    return r;
  }

  private setSubFlags(a: number, b: number, result: number): number {
    const r = this.setZS(result);
    this.setFlag(FLAG.CF, a >>> 0 < b >>> 0);
    this.setFlag(FLAG.OF, ((a ^ b) & (a ^ r) & 0x80000000) !== 0);
    return r;
  }

  private setFlag(bit: number, on: boolean): void {
    if (on) this.flags |= bit;
    else this.flags &= ~bit;
  }

  private getFlag(bit: number): boolean {
    return (this.flags & bit) !== 0;
  }

  private signedLess(): boolean {
    return this.getFlag(FLAG.SF) !== this.getFlag(FLAG.OF);
  }

  // --- stack (downward-growing) ---

  private push(value: number): void {
    this.sp -= WORD;
    this.write32(this.sp, value);
  }

  private pop(): number {
    const v = this.read32(this.sp);
    this.sp += WORD;
    return v;
  }

  // --- execution loop ---

  run(maxCycles: number): RunResult {
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      try {
        const result = this.step();
        if (result) return result; // INT / HLT returns immediately
      } catch (e) {
        if (e instanceof CpuFault) return { reason: 'fault', message: e.message };
        throw e; // don't swallow unexpected bugs
      }
    }
    return { reason: 'quantum' };
  }

  // Execute one instruction. Returns a RunResult only for INT / HLT; otherwise undefined.
  private step(): RunResult | undefined {
    const opcode = this.fetchU8();
    const entry = OPCODE_TABLE.get(opcode);
    if (!entry) {
      throw new CpuFault(`illegal opcode: 0x${opcode.toString(16)}`);
    }

    // Read operands in the order given by the spec table.
    const ops: number[] = [];
    for (const kind of entry.args) ops.push(this.fetchOperand(kind));

    const r = this.regs;
    switch (entry.mnemonic) {
      // --- data movement ---
      case 'NOP':
        break;
      case 'MOV':
        r[ops[0]!] = ops[1]! >>> 0;
        break;
      case 'MOVR':
        r[ops[0]!] = r[ops[1]!]!;
        break;
      case 'LOAD':
        r[ops[0]!] = this.read32(ops[1]!);
        break;
      case 'STORE':
        this.write32(ops[1]!, r[ops[0]!]!);
        break;
      case 'LOADR':
        r[ops[0]!] = this.read32(r[ops[1]!]!);
        break;
      case 'STORER':
        this.write32(r[ops[0]!]!, r[ops[1]!]!);
        break;

      // --- arithmetic / logic ---
      case 'ADD': {
        const a = r[ops[0]!]!;
        const b = r[ops[1]!]!;
        r[ops[0]!] = this.setAddFlags(a, b, a + b);
        break;
      }
      case 'SUB': {
        const a = r[ops[0]!]!;
        const b = r[ops[1]!]!;
        r[ops[0]!] = this.setSubFlags(a, b, a - b);
        break;
      }
      case 'MUL': {
        // Drop the high 32 bits. Math.imul is signed but the low 32 bits match.
        const prod = Math.imul(r[ops[0]!]!, r[ops[1]!]!);
        r[ops[0]!] = this.setZS(prod);
        break;
      }
      case 'DIV': {
        const b = r[ops[1]!]!;
        if (b === 0) throw new CpuFault('divide by zero');
        r[ops[0]!] = this.setZS(Math.floor(r[ops[0]!]! / b));
        break;
      }
      case 'MOD': {
        const b = r[ops[1]!]!;
        if (b === 0) throw new CpuFault('divide by zero (MOD)');
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
        r[ops[0]!] = this.setAddFlags(r[ops[0]!]!, 1, r[ops[0]!]! + 1);
        break;
      case 'DEC':
        r[ops[0]!] = this.setSubFlags(r[ops[0]!]!, 1, r[ops[0]!]! - 1);
        break;
      case 'CMP': {
        const a = r[ops[0]!]!;
        const b = r[ops[1]!]!;
        this.setSubFlags(a, b, a - b); // discard the result, update flags only
        break;
      }

      // --- control flow ---
      case 'JMP':
        this.pc = ops[0]!;
        break;
      case 'JZ':
        if (this.getFlag(FLAG.ZF)) this.pc = ops[0]!;
        break;
      case 'JNZ':
        if (!this.getFlag(FLAG.ZF)) this.pc = ops[0]!;
        break;
      case 'JG': // a > b (signed): ZF==0 and SF==OF
        if (!this.getFlag(FLAG.ZF) && !this.signedLess()) this.pc = ops[0]!;
        break;
      case 'JGE': // a >= b: SF==OF
        if (!this.signedLess()) this.pc = ops[0]!;
        break;
      case 'JL': // a < b: SF!=OF
        if (this.signedLess()) this.pc = ops[0]!;
        break;
      case 'JLE': // a <= b: SF!=OF or ZF==1
        if (this.signedLess() || this.getFlag(FLAG.ZF)) this.pc = ops[0]!;
        break;
      case 'CALL':
        this.push(this.pc); // save the return address (next instruction after CALL)
        this.pc = ops[0]!;
        break;
      case 'RET':
        this.pc = this.pop();
        break;

      // --- stack ---
      case 'PUSH':
        this.push(r[ops[0]!]!);
        break;
      case 'POP':
        r[ops[0]!] = this.pop();
        break;

      // --- system ---
      case 'INT':
        // PC already points past INT, so the OS can resume after handling the syscall.
        return { reason: 'int', int: ops[0]! >>> 0 };
      case 'EI':
        this.setFlag(FLAG.IF, true);
        break;
      case 'DI':
        this.setFlag(FLAG.IF, false);
        break;
      case 'HLT':
        return { reason: 'halt' };
      default:
        // A decodable opcode v1 cannot execute (e.g. v2-only IN/OUT/IRET) -> fault.
        throw new CpuFault(`unsupported instruction in v1: ${entry.mnemonic}`);
    }
    return undefined;
  }
}
