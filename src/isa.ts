// ISA table: the single source of truth shared by the CPU and the assembler.
//
// Operand kinds:
//   'reg'  : 1 byte  register number (0-7)
//   'imm'  : 4 byte  immediate (little-endian 32-bit)
//   'addr' : 4 byte  absolute memory address (labels resolved by the assembler)

export type ArgKind = 'reg' | 'imm' | 'addr';

export interface InstrSpec {
  readonly opcode: number;
  readonly args: readonly ArgKind[];
}

export const ISA = {
  // --- data movement ---
  NOP: { opcode: 0x00, args: [] },
  MOV: { opcode: 0x01, args: ['reg', 'imm'] },
  MOVR: { opcode: 0x02, args: ['reg', 'reg'] },
  LOAD: { opcode: 0x03, args: ['reg', 'addr'] },
  STORE: { opcode: 0x04, args: ['reg', 'addr'] },
  LOADR: { opcode: 0x05, args: ['reg', 'reg'] },
  STORER: { opcode: 0x06, args: ['reg', 'reg'] },
  LB: { opcode: 0x07, args: ['reg', 'reg'] }, // rd = mem8[ra] (zero-extended)
  SB: { opcode: 0x08, args: ['reg', 'reg'] }, // mem8[ra] = rv & 0xff  (operands: ra, rv)

  // --- arithmetic / logic (update ZF/SF/CF) ---
  ADD: { opcode: 0x10, args: ['reg', 'reg'] },
  SUB: { opcode: 0x11, args: ['reg', 'reg'] },
  MUL: { opcode: 0x12, args: ['reg', 'reg'] },
  DIV: { opcode: 0x13, args: ['reg', 'reg'] },
  MOD: { opcode: 0x14, args: ['reg', 'reg'] },
  AND: { opcode: 0x15, args: ['reg', 'reg'] },
  OR: { opcode: 0x16, args: ['reg', 'reg'] },
  XOR: { opcode: 0x17, args: ['reg', 'reg'] },
  NOT: { opcode: 0x18, args: ['reg'] },
  SHL: { opcode: 0x19, args: ['reg', 'reg'] },
  SHR: { opcode: 0x1a, args: ['reg', 'reg'] },
  INC: { opcode: 0x1b, args: ['reg'] },
  DEC: { opcode: 0x1c, args: ['reg'] },
  CMP: { opcode: 0x1d, args: ['reg', 'reg'] },

  // --- control flow ---
  JMP: { opcode: 0x20, args: ['addr'] },
  JZ: { opcode: 0x21, args: ['addr'] },
  JNZ: { opcode: 0x22, args: ['addr'] },
  JG: { opcode: 0x23, args: ['addr'] },
  JGE: { opcode: 0x24, args: ['addr'] },
  JL: { opcode: 0x25, args: ['addr'] },
  JLE: { opcode: 0x26, args: ['addr'] },
  CALL: { opcode: 0x27, args: ['addr'] },
  RET: { opcode: 0x28, args: [] },

  // --- stack ---
  PUSH: { opcode: 0x30, args: ['reg'] },
  POP: { opcode: 0x31, args: ['reg'] },

  // --- system ---
  INT: { opcode: 0x40, args: ['imm'] },
  EI: { opcode: 0x41, args: [] },
  DI: { opcode: 0x42, args: [] },
  // --- port I/O (v2, privileged) ---
  IN: { opcode: 0x43, args: ['reg', 'reg'] }, // rd = port[rp]
  OUT: { opcode: 0x44, args: ['reg', 'reg'] }, // port[rp] = rs  (operands: rp, rs)
  IRET: { opcode: 0x45, args: [] }, // return from trap (reserved for model B / Phase 7)
  HLT: { opcode: 0xff, args: [] },
} as const satisfies Record<string, InstrSpec>;

// Mnemonics the v2 CPU treats as privileged (executing them in USER mode traps).
export const PRIVILEGED: ReadonlySet<Mnemonic> = new Set(['IN', 'OUT', 'IRET', 'HLT', 'EI', 'DI']);

export type Mnemonic = keyof typeof ISA;

// Reverse table: opcode (number) -> { mnemonic, args }. Used by the decoder.
export const OPCODE_TABLE: ReadonlyMap<number, { mnemonic: Mnemonic; args: readonly ArgKind[] }> =
  (() => {
    const table = new Map<number, { mnemonic: Mnemonic; args: readonly ArgKind[] }>();
    for (const [mnemonic, spec] of Object.entries(ISA) as [Mnemonic, InstrSpec][]) {
      if (table.has(spec.opcode)) {
        throw new Error(`ISA: duplicate opcode 0x${spec.opcode.toString(16)}`);
      }
      table.set(spec.opcode, { mnemonic, args: spec.args });
    }
    return table;
  })();

// Byte width of each operand kind.
export const ARG_SIZE: Record<ArgKind, number> = { reg: 1, imm: 4, addr: 4 };

// FLAGS bits
export const FLAG = {
  ZF: 1 << 0, // result is zero
  SF: 1 << 1, // top bit (sign) of the result is 1
  CF: 1 << 2, // carry / borrow
  IF: 1 << 3, // interrupts enabled
} as const;

// syscall numbers
export const SYS = {
  EXIT: 0,
  WRITE: 1,
  YIELD: 2,
  GETPID: 3,
  SPAWN: 4,
  SLEEP: 5,
} as const;

// Soft-interrupt number that triggers a syscall (Linux-style).
export const SYSCALL_INT = 0x80;
