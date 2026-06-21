// ISA テーブル: CPU とアセンブラが共有する「単一の真実」(DESIGN §3, §5)。
//
// オペランド種別:
//   'reg'  : 1 byte  レジスタ番号 (0-7)
//   'imm'  : 4 byte  即値 (リトルエンディアン 32bit)
//   'addr' : 4 byte  絶対メモリアドレス (アセンブラがラベルを解決)

export type ArgKind = 'reg' | 'imm' | 'addr';

export interface InstrSpec {
  readonly opcode: number;
  readonly args: readonly ArgKind[];
}

export const ISA = {
  // --- データ移動 ---
  NOP:    { opcode: 0x00, args: [] },
  MOV:    { opcode: 0x01, args: ['reg', 'imm'] },
  MOVR:   { opcode: 0x02, args: ['reg', 'reg'] },
  LOAD:   { opcode: 0x03, args: ['reg', 'addr'] },
  STORE:  { opcode: 0x04, args: ['reg', 'addr'] },
  LOADR:  { opcode: 0x05, args: ['reg', 'reg'] },
  STORER: { opcode: 0x06, args: ['reg', 'reg'] },

  // --- 算術・論理 (ZF/SF/CF を更新) ---
  ADD:    { opcode: 0x10, args: ['reg', 'reg'] },
  SUB:    { opcode: 0x11, args: ['reg', 'reg'] },
  MUL:    { opcode: 0x12, args: ['reg', 'reg'] },
  DIV:    { opcode: 0x13, args: ['reg', 'reg'] },
  MOD:    { opcode: 0x14, args: ['reg', 'reg'] },
  AND:    { opcode: 0x15, args: ['reg', 'reg'] },
  OR:     { opcode: 0x16, args: ['reg', 'reg'] },
  XOR:    { opcode: 0x17, args: ['reg', 'reg'] },
  NOT:    { opcode: 0x18, args: ['reg'] },
  SHL:    { opcode: 0x19, args: ['reg', 'reg'] },
  SHR:    { opcode: 0x1a, args: ['reg', 'reg'] },
  INC:    { opcode: 0x1b, args: ['reg'] },
  DEC:    { opcode: 0x1c, args: ['reg'] },
  CMP:    { opcode: 0x1d, args: ['reg', 'reg'] },

  // --- 制御フロー ---
  JMP:    { opcode: 0x20, args: ['addr'] },
  JZ:     { opcode: 0x21, args: ['addr'] },
  JNZ:    { opcode: 0x22, args: ['addr'] },
  JG:     { opcode: 0x23, args: ['addr'] },
  JGE:    { opcode: 0x24, args: ['addr'] },
  JL:     { opcode: 0x25, args: ['addr'] },
  JLE:    { opcode: 0x26, args: ['addr'] },
  CALL:   { opcode: 0x27, args: ['addr'] },
  RET:    { opcode: 0x28, args: [] },

  // --- スタック ---
  PUSH:   { opcode: 0x30, args: ['reg'] },
  POP:    { opcode: 0x31, args: ['reg'] },

  // --- システム ---
  INT:    { opcode: 0x40, args: ['imm'] },
  EI:     { opcode: 0x41, args: [] },
  DI:     { opcode: 0x42, args: [] },
  HLT:    { opcode: 0xff, args: [] },
} as const satisfies Record<string, InstrSpec>;

export type Mnemonic = keyof typeof ISA;

// オペコード(数値) → { mnemonic, args } の逆引きテーブル。デコーダ用。
export const OPCODE_TABLE: ReadonlyMap<number, { mnemonic: Mnemonic; args: readonly ArgKind[] }> =
  (() => {
    const table = new Map<number, { mnemonic: Mnemonic; args: readonly ArgKind[] }>();
    for (const [mnemonic, spec] of Object.entries(ISA) as [Mnemonic, InstrSpec][]) {
      if (table.has(spec.opcode)) {
        throw new Error(`ISA: opcode 0x${spec.opcode.toString(16)} が重複しています`);
      }
      table.set(spec.opcode, { mnemonic, args: spec.args });
    }
    return table;
  })();

// オペランド種別ごとのバイト幅。
export const ARG_SIZE: Record<ArgKind, number> = { reg: 1, imm: 4, addr: 4 };

// FLAGS ビット (DESIGN §1)
export const FLAG = {
  ZF: 1 << 0, // 結果が 0
  SF: 1 << 1, // 結果の最上位ビット (符号) が 1
  CF: 1 << 2, // キャリー / ボロー
  IF: 1 << 3, // 割り込み許可
} as const;

// syscall 番号 (DESIGN §7)
export const SYS = {
  EXIT: 0,
  WRITE: 1,
  YIELD: 2,
  GETPID: 3,
  SPAWN: 4,
  SLEEP: 5,
} as const;

// syscall を起こすソフト割り込み番号 (Linux 風)
export const SYSCALL_INT = 0x80;
