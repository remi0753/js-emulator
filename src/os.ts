// OS 層 (DESIGN §6, §7, §9): PCB / ラウンドロビン・スケジューラ /
// syscall ディスパッチ / プログラムローダ。
//
// CPU の run(QUANTUM) が必ず JS へ戻る性質を使い、JS 側で時分割制御を行う
// ことでプリエンプティブ・マルチタスクを実現する。

import { CPU, MEM_SIZE, type Context, type RunResult } from './cpu.ts';
import { assemble } from './assembler.ts';
import { SYS, SYSCALL_INT } from './isa.ts';

export type ProcState = 'ready' | 'running' | 'blocked' | 'terminated';

// Process Control Block (DESIGN §6)
export interface PCB {
  pid: number;
  name: string;
  programId: number;
  ctx: Context;
  state: ProcState;
  exitCode: number | null;
  wakeAt: number; // SLEEP の起床時刻 (clock 基準)
}

interface Program {
  id: number;
  name: string;
  bytes: Uint8Array;
}

export interface OSOptions {
  quantum?: number; // 1 プロセスに与える命令数 (DESIGN §6)
  // コンソール出力先。テストでは差し替え可能。char と発信プロセスを受け取る。
  onWrite?: (char: string, pcb: PCB) => void;
  log?: (msg: string) => void; // カーネルログ (終了 / フォルト等)
}

export class OS {
  private cpu = new CPU();
  private programs = new Map<number, Program>();
  private nextProgramId = 1;

  processes = new Map<number, PCB>();
  private readyQueue: PCB[] = [];
  private sleepers: PCB[] = [];
  private nextPid = 1;
  private clock = 0; // 経過時間 = 実行したクォンタム数

  readonly quantum: number;
  private onWrite: (char: string, pcb: PCB) => void;
  private log: (msg: string) => void;

  // 収集した全コンソール出力 (テスト / 確認用)。
  output = '';

  constructor(opts: OSOptions = {}) {
    this.quantum = opts.quantum ?? 1000;
    this.onWrite = opts.onWrite ?? ((c) => process.stdout.write(c));
    this.log = opts.log ?? (() => {});
  }

  // --- プログラム管理 ---

  // アセンブリソースを登録し、SPAWN で使えるプログラム ID を返す。
  loadProgram(name: string, source: string): number {
    const { bytes } = assemble(source);
    const id = this.nextProgramId++;
    this.programs.set(id, { id, name, bytes });
    return id;
  }

  // --- プロセス生成 (loader, DESIGN §9) ---

  // プログラム ID から新しいプロセスを生成し ready キューへ。失敗時は null。
  spawn(programId: number): PCB | null {
    const prog = this.programs.get(programId);
    if (!prog) return null;

    // v1: プロセスごとに独立したメモリイメージ (DESIGN §2 プロセス分離)
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

  // --- スケジューラ本体 (DESIGN §6 のメインループ) ---

  run(): void {
    while (this.readyQueue.length > 0 || this.sleepers.length > 0) {
      if (this.readyQueue.length === 0) {
        // 走れるプロセスが無く、寝ているだけ → 時計を進めて起こす。
        this.advanceClockToNextWake();
        continue;
      }

      const pcb = this.readyQueue.shift()!;
      pcb.state = 'running';

      this.cpu.loadContext(pcb.ctx);
      const r = this.cpu.run(this.quantum);
      this.cpu.saveContext(pcb.ctx);

      this.clock++; // 1 クォンタム分の時間が経過
      this.wakeSleepers();

      this.dispatch(pcb, r);
    }
  }

  private dispatch(pcb: PCB, r: RunResult): void {
    switch (r.reason) {
      case 'quantum': // 時間切れ → 末尾へ (ラウンドロビン)
        this.makeReady(pcb);
        break;
      case 'int':
        if (r.int === SYSCALL_INT) this.handleSyscall(pcb);
        else {
          this.log(`pid ${pcb.pid}: 未対応の INT 0x${r.int.toString(16)} → 終了`);
          this.terminate(pcb, -1);
        }
        break;
      case 'halt': // HLT → プロセス終了
        this.log(`pid ${pcb.pid} (${pcb.name}): HLT`);
        this.terminate(pcb, 0);
        break;
      case 'fault':
        this.log(`pid ${pcb.pid} (${pcb.name}): フォルト: ${r.message} → 強制終了`);
        this.terminate(pcb, -1);
        break;
    }
  }

  // --- syscall ディスパッチ (DESIGN §7) ---

  private handleSyscall(pcb: PCB): void {
    const regs = pcb.ctx.regs;
    const num = regs[0]!; // R0 = syscall 番号
    const a1 = regs[1]!; // R1 = 第1引数

    switch (num) {
      case SYS.EXIT:
        this.log(`pid ${pcb.pid} (${pcb.name}): EXIT code=${a1}`);
        this.terminate(pcb, a1);
        break;

      case SYS.WRITE: {
        const char = String.fromCharCode(a1 & 0xff);
        this.output += char;
        this.onWrite(char, pcb);
        regs[0] = 0; // 戻り値
        this.makeReady(pcb);
        break;
      }

      case SYS.YIELD: // 自発的に CPU を手放す → 末尾へ
        this.makeReady(pcb);
        break;

      case SYS.GETPID:
        regs[0] = pcb.pid;
        this.makeReady(pcb);
        break;

      case SYS.SPAWN: {
        const child = this.spawn(a1); // R1 = プログラム ID
        regs[0] = child ? child.pid : 0xffffffff; // 失敗は -1 (符号なし)
        this.makeReady(pcb);
        break;
      }

      case SYS.SLEEP: // R1 ティック後に起床するまでブロック
        pcb.state = 'blocked';
        pcb.wakeAt = this.clock + a1;
        this.sleepers.push(pcb);
        break;

      default:
        this.log(`pid ${pcb.pid}: 未知の syscall ${num}`);
        regs[0] = 0xffffffff;
        this.makeReady(pcb);
        break;
    }
  }

  // --- プロセス状態遷移ヘルパ ---

  private makeReady(pcb: PCB): void {
    pcb.state = 'ready';
    this.readyQueue.push(pcb);
  }

  private terminate(pcb: PCB, code: number): void {
    pcb.state = 'terminated';
    pcb.exitCode = code | 0;
    // キューには戻さない。記録のため processes には残す。
  }

  // --- スリープ管理 (v1 は実タイマの代替) ---

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
    if (next === Infinity) return; // 念のため (デッドロック回避)
    this.clock = next;
    this.wakeSleepers();
  }
}
