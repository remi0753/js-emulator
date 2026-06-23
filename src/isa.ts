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
  IRET: { opcode: 0x45, args: [] }, // return from a trap handler (model B / Phase 8)
  // --- trap / interrupt entry (v2 model B, privileged) ---
  LIDT: { opcode: 0x46, args: ['reg'] }, // IDTR = rX (physical base of the trap descriptor table)
  LKSP: { opcode: 0x47, args: ['reg'] }, // kernel stack pointer (esp0) used on USER->KERNEL entry
  RDPFLA: { opcode: 0x48, args: ['reg'] }, // rX = faulting linear address (CR2) of the last page fault
  RDERR: { opcode: 0x49, args: ['reg'] }, // rX = error code of the last trap
  STMR: { opcode: 0x4a, args: ['reg'] }, // arm the in-CPU timer: IRQ0 every rX instructions (0 = off)
  LPTBR: { opcode: 0x4b, args: ['reg'] }, // PTBR/CR3 = rX (physical page-directory base)
  PGON: { opcode: 0x4c, args: [] }, // enable paging
  PGOFF: { opcode: 0x4d, args: [] }, // disable paging
  HLT: { opcode: 0xff, args: [] },
} as const satisfies Record<string, InstrSpec>;

// Mnemonics the v2 CPU treats as privileged (executing them in USER mode traps).
export const PRIVILEGED: ReadonlySet<Mnemonic> = new Set([
  'IN',
  'OUT',
  'IRET',
  'HLT',
  'EI',
  'DI',
  'LIDT',
  'LKSP',
  'RDPFLA',
  'RDERR',
  'STMR',
  'LPTBR',
  'PGON',
  'PGOFF',
]);

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

// Trap vectors (model B). CPU exceptions and device IRQs index the IDT here;
// a software INT n indexes vector n directly (so a syscall uses SYSCALL_INT).
export const TRAP = {
  DIVZERO: 0, // divide by zero
  ILLOP: 6, // illegal / unimplemented opcode (x86 #UD)
  GP: 13, // general protection: privileged instr in user mode, phys range (x86 #GP)
  PAGEFAULT: 14, // page fault (x86 #PF); pushes an error code, sets PFLA/CR2
  IRQ_BASE: 32, // device IRQ line n is delivered at vector IRQ_BASE + n
} as const;

// The timer is wired to IRQ line 0 -> vector TRAP.IRQ_BASE.
export const TIMER_IRQ = 0;
export const KEYBOARD_IRQ = 1;

// IDT layout: a flat table of 8-byte gate descriptors indexed by vector.
//   +0: handler virtual address (offset)   +4: flags (bit 0 = Present)
export const IDT_ENTRY_SIZE = 8;
export const IDT_PRESENT = 1 << 0;
// Software INT from USER mode may enter only gates carrying this bit. Hardware
// exceptions and IRQs ignore it.
export const IDT_USER = 1 << 1;

// Page-fault error-code bits (pushed as the trap error code; readable via RDERR).
export const PF_ERR = {
  PRESENT: 1 << 0, // 0 = page not present, 1 = protection violation
  WRITE: 1 << 1, // the access was a write
  USER: 1 << 2, // the access came from USER mode
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
