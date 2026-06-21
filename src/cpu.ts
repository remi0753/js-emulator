// 仮想レジスタマシン CPU (DESIGN §1, §2, §6)。
//
// 設計の核心: run(maxCycles) は maxCycles 命令を実行するか、INT / HLT /
// フォルトが起きた時点で必ず JS 側へ制御を返す。これがハードウェアタイマ
// 割り込みの代わりとなり、OS(JS)によるプリエンプションを成立させる。

import { OPCODE_TABLE, ARG_SIZE, FLAG, type ArgKind } from './isa.ts';

export const MEM_SIZE = 64 * 1024; // 64 KiB (DESIGN §2)
export const NUM_REGS = 8; // R0-R7
export const WORD = 4; // 32bit ワード

// run() が JS へ戻る理由 (DESIGN §6)。discriminated union。
export type RunResult =
  | { reason: 'quantum' }
  | { reason: 'int'; int: number }
  | { reason: 'halt' }
  | { reason: 'fault'; message: string };

// プロセスの実行状態 (DESIGN §6 のコンテキスト)。
export interface Context {
  regs: number[]; // R0-R7 (length 8)
  pc: number;
  sp: number;
  flags: number;
  mem: Uint8Array; // v1: プロセス専用メモリイメージ
}

// 不正な実行を表す内部例外。run() のループ内でだけ使い、fault に変換する。
class CpuFault extends Error {}

export class CPU {
  regs: number[] = new Array(NUM_REGS).fill(0);
  pc = 0;
  sp = MEM_SIZE; // 下方成長スタック。最初の PUSH で SP -= 4。
  flags = 0;
  mem: Uint8Array = new Uint8Array(MEM_SIZE);

  // --- コンテキスト操作 (DESIGN §6) ---

  loadContext(ctx: Context): void {
    this.regs = ctx.regs;
    this.pc = ctx.pc;
    this.sp = ctx.sp;
    this.flags = ctx.flags;
    this.mem = ctx.mem; // 参照を差し替える (v1 はプロセスごとに別メモリ)
  }

  saveContext(ctx: Context): void {
    // regs / mem は参照を共有しているため、スカラだけ書き戻せばよい。
    ctx.pc = this.pc;
    ctx.sp = this.sp;
    ctx.flags = this.flags;
  }

  // --- メモリアクセス (リトルエンディアン 32bit, DESIGN §2) ---

  private read32(addr: number): number {
    if (addr < 0 || addr + WORD > MEM_SIZE) {
      throw new CpuFault(`メモリ読み出し範囲外: 0x${addr.toString(16)}`);
    }
    const m = this.mem;
    return (m[addr]! | (m[addr + 1]! << 8) | (m[addr + 2]! << 16) | (m[addr + 3]! << 24)) >>> 0;
  }

  private write32(addr: number, value: number): void {
    if (addr < 0 || addr + WORD > MEM_SIZE) {
      throw new CpuFault(`メモリ書き込み範囲外: 0x${addr.toString(16)}`);
    }
    const v = value >>> 0;
    const m = this.mem;
    m[addr] = v & 0xff;
    m[addr + 1] = (v >>> 8) & 0xff;
    m[addr + 2] = (v >>> 16) & 0xff;
    m[addr + 3] = (v >>> 24) & 0xff;
  }

  // --- 命令フェッチ (PC を進めながら読む) ---

  private fetchU8(): number {
    if (this.pc < 0 || this.pc >= MEM_SIZE) {
      throw new CpuFault(`命令フェッチ範囲外: PC=0x${this.pc.toString(16)}`);
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
      if (r >= NUM_REGS) throw new CpuFault(`不正なレジスタ番号: ${r}`);
      return r;
    }
    // imm / addr はどちらも 4 byte
    return this.fetchU32();
  }

  // --- フラグ更新 ---

  // 算術・論理結果に基づき ZF/SF を更新 (CF は呼び出し側で個別に)。
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

  // --- スタック (下方成長, DESIGN §2) ---

  private push(value: number): void {
    this.sp -= WORD;
    this.write32(this.sp, value);
  }

  private pop(): number {
    const v = this.read32(this.sp);
    this.sp += WORD;
    return v;
  }

  // --- 実行ループ (DESIGN §6) ---

  run(maxCycles: number): RunResult {
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      try {
        const result = this.step();
        if (result) return result; // INT / HLT で即座に戻る
      } catch (e) {
        if (e instanceof CpuFault) return { reason: 'fault', message: e.message };
        throw e; // 想定外のバグは握りつぶさない
      }
    }
    return { reason: 'quantum' };
  }

  // 1 命令を実行。INT / HLT のときだけ RunResult を返し、それ以外は undefined。
  private step(): RunResult | undefined {
    const opcode = this.fetchU8();
    const entry = OPCODE_TABLE.get(opcode);
    if (!entry) {
      throw new CpuFault(`不正なオペコード: 0x${opcode.toString(16)}`);
    }

    // オペランドを仕様テーブル順に読む。
    const ops: number[] = [];
    for (const kind of entry.args) ops.push(this.fetchOperand(kind));

    const r = this.regs;
    switch (entry.mnemonic) {
      // --- データ移動 ---
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

      // --- 算術・論理 ---
      case 'ADD': {
        const sum = r[ops[0]!]! + r[ops[1]!]!;
        this.setFlag(FLAG.CF, sum > 0xffffffff);
        r[ops[0]!] = this.setZS(sum);
        break;
      }
      case 'SUB': {
        const a = r[ops[0]!]!;
        const b = r[ops[1]!]!;
        this.setFlag(FLAG.CF, a < b); // ボロー
        r[ops[0]!] = this.setZS(a - b);
        break;
      }
      case 'MUL': {
        // 32bit 上位は捨てる。Math.imul は符号付きだが下位 32bit は同じ。
        const prod = Math.imul(r[ops[0]!]!, r[ops[1]!]!);
        r[ops[0]!] = this.setZS(prod);
        break;
      }
      case 'DIV': {
        const b = r[ops[1]!]!;
        if (b === 0) throw new CpuFault('0 除算');
        r[ops[0]!] = this.setZS(Math.floor(r[ops[0]!]! / b));
        break;
      }
      case 'MOD': {
        const b = r[ops[1]!]!;
        if (b === 0) throw new CpuFault('0 除算 (MOD)');
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
        this.setZS(a - b); // 結果は捨て、フラグだけ更新
        break;
      }

      // --- 制御フロー ---
      case 'JMP':
        this.pc = ops[0]!;
        break;
      case 'JZ':
        if (this.getFlag(FLAG.ZF)) this.pc = ops[0]!;
        break;
      case 'JNZ':
        if (!this.getFlag(FLAG.ZF)) this.pc = ops[0]!;
        break;
      case 'JG': // a > b (符号付き): ZF==0 かつ SF==0
        if (!this.getFlag(FLAG.ZF) && !this.getFlag(FLAG.SF)) this.pc = ops[0]!;
        break;
      case 'JGE': // a >= b: SF==0
        if (!this.getFlag(FLAG.SF)) this.pc = ops[0]!;
        break;
      case 'JL': // a < b: SF==1
        if (this.getFlag(FLAG.SF)) this.pc = ops[0]!;
        break;
      case 'JLE': // a <= b: SF==1 または ZF==1
        if (this.getFlag(FLAG.SF) || this.getFlag(FLAG.ZF)) this.pc = ops[0]!;
        break;
      case 'CALL':
        this.push(this.pc); // 戻り番地 (INT/CALL 後の次命令) を保存
        this.pc = ops[0]!;
        break;
      case 'RET':
        this.pc = this.pop();
        break;

      // --- スタック ---
      case 'PUSH':
        this.push(r[ops[0]!]!);
        break;
      case 'POP':
        r[ops[0]!] = this.pop();
        break;

      // --- システム ---
      case 'INT':
        // PC は既に INT の次命令を指している。OS が syscall 処理後に再開できる。
        return { reason: 'int', int: ops[0]! >>> 0 };
      case 'EI':
        this.setFlag(FLAG.IF, true);
        break;
      case 'DI':
        this.setFlag(FLAG.IF, false);
        break;
      case 'HLT':
        return { reason: 'halt' };
    }
    return undefined;
  }
}
