// v2 CPU。物理メモリ + ページング MMU + ポート I/O + 特権レベルを持つ。
//
// model A: CPU はユーザープログラム (ゲストバイトコード) を USER モードで実行し、
// トラップ / フォルト / 割り込みが起きると run() が TS カーネルへ制御を返す。
// カーネルは状態を調べて再開する。

import { FLAG, OPCODE_TABLE, PRIVILEGED } from '../isa.ts';
import { type PhysicalMemory, WORD } from './memory.ts';
import { Mmu } from './mmu.ts';
import type { PortBus } from './ports.ts';

export const NUM_REGS = 8;

export const MODE = { KERNEL: 0, USER: 1 } as const;
export type Mode = (typeof MODE)[keyof typeof MODE];

export type FaultKind =
  | 'illegal-opcode'
  | 'divide-by-zero'
  | 'privileged' // USER モードで特権命令
  | 'illegal' // 未実装命令など
  | 'phys-range'; // ページング無効時の物理範囲外

// run() が JS (カーネル) へ戻る理由 (DESIGN v2 §トラップ)。
export type RunResult =
  | { reason: 'timer' } // クォンタム満了 (PIT tick) → プリエンプション
  | { reason: 'syscall'; num: number } // INT n
  | { reason: 'pagefault'; vaddr: number; write: boolean; user: boolean; present: boolean }
  | { reason: 'fault'; kind: FaultKind; message: string }
  | { reason: 'halt' } // HLT (カーネルモード / ブート時)
  | { reason: 'irq'; line: number }; // デバイス割り込み

// CPU の保存可能な状態 (プロセスのトラップフレームに相当)。
export interface CpuState {
  regs: number[];
  pc: number;
  sp: number;
  flags: number;
  mode: Mode;
  ptbr: number;
  pagingEnabled: boolean;
}

// 実行ループ内部でのみ使う例外。run() がトラップ結果へ変換する。
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
  ptbr = 0; // ページディレクトリの物理アドレス (CR3 相当)
  pagingEnabled = false;
  pfla = 0; // 直近のページフォルト線形アドレス (CR2 相当)

  readonly mmu: Mmu;
  readonly phys: PhysicalMemory;
  readonly ports: PortBus;
  private pendingIrq: number | null = null;

  constructor(phys: PhysicalMemory, ports: PortBus) {
    this.phys = phys;
    this.ports = ports;
    this.mmu = new Mmu(phys);
  }

  // --- 状態の保存 / 復元 ---

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

  // デバイスからの割り込み要求。次の命令境界で IF が立っていれば run() が返す。
  raiseIrq(line: number): void {
    this.pendingIrq = line;
  }

  // --- アドレス変換付きメモリアクセス ---

  private xlate(vaddr: number, write: boolean): number {
    if (!this.pagingEnabled) {
      if (vaddr < 0 || vaddr + 1 > this.phys.size) {
        throw new CpuFault('phys-range', `物理範囲外: 0x${vaddr.toString(16)}`);
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

  // --- フェッチ (PC を進める) ---

  private fetch8(): number {
    return this.rd8(this.pc++);
  }
  private fetch32(): number {
    const v = this.rd32(this.pc);
    this.pc += WORD;
    return v;
  }

  // --- フラグ / スタック ---

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

  // --- 実行ループ ---

  run(maxCycles: number): RunResult {
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      // 命令境界で割り込みをチェック (IF が立っているときのみ受け付ける)。
      if (this.pendingIrq !== null && this.getFlag(FLAG.IF)) {
        const line = this.pendingIrq;
        this.pendingIrq = null;
        return { reason: 'irq', line };
      }
      try {
        const result = this.step();
        if (result) return result;
      } catch (e) {
        if (e instanceof PageFault) {
          return {
            reason: 'pagefault',
            vaddr: e.vaddr,
            write: e.write,
            user: e.user,
            present: e.present,
          };
        }
        if (e instanceof CpuFault) {
          return { reason: 'fault', kind: e.kind, message: e.message };
        }
        throw e;
      }
    }
    return { reason: 'timer' };
  }

  private step(): RunResult | undefined {
    const opcode = this.fetch8();
    const entry = OPCODE_TABLE.get(opcode);
    if (!entry) throw new CpuFault('illegal-opcode', `不正なオペコード: 0x${opcode.toString(16)}`);

    // 特権命令を USER モードで実行したらトラップ。
    if (this.mode === MODE.USER && PRIVILEGED.has(entry.mnemonic)) {
      throw new CpuFault('privileged', `USER モードでの特権命令: ${entry.mnemonic}`);
    }

    // オペランドを仕様テーブル順に読む。
    const ops: number[] = [];
    for (const kind of entry.args) {
      if (kind === 'reg') {
        const r = this.fetch8();
        if (r >= NUM_REGS) throw new CpuFault('illegal', `不正なレジスタ番号: ${r}`);
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
        if (b === 0) throw new CpuFault('divide-by-zero', '0 除算');
        r[ops[0]!] = this.setZS(Math.floor(r[ops[0]!]! / b));
        break;
      }
      case 'MOD': {
        const b = r[ops[1]!]!;
        if (b === 0) throw new CpuFault('divide-by-zero', '0 除算 (MOD)');
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

      // --- システム ---
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
      case 'OUT': // port[rp] = rs   (オペランド: rp, rs)
        this.ports.out(r[ops[0]!]!, r[ops[1]!]!);
        break;
      case 'IRET':
        throw new CpuFault('illegal', 'IRET は未実装 (model B / Phase 7)');
      case 'HLT':
        return { reason: 'halt' };
    }
    return undefined;
  }
}
