# Instruction Set & Encoding

All registers hold unsigned 32-bit integers; some instructions interpret them as
signed during the operation.

## Registers

| Register  | Purpose                                                   |
|-----------|----------------------------------------------------------|
| `R0`–`R7` | general purpose (8)                                       |
| `PC`      | program counter (address of the next instruction)        |
| `SP`      | stack pointer (points at free top; downward-growing)     |
| `FLAGS`   | status flags (below)                                      |

### FLAGS bits

| Bit | Name | Meaning                                  |
|-----|------|------------------------------------------|
| 0   | `ZF` | last result was zero                     |
| 1   | `SF` | top bit (sign) of the result is 1        |
| 2   | `CF` | carry / borrow occurred                  |
| 3   | `IF` | interrupts enabled (`EI`/`DI`)           |

Conditional jumps read these flags after a `CMP a,b` (which computes `a - b` and
discards the result). Signed comparisons are judged from `SF`/`ZF`:
`JG`=`!ZF && !SF`, `JGE`=`!SF`, `JL`=`SF`, `JLE`=`SF || ZF`.

## Memory model

- Memory is a `Uint8Array`, default 64 KiB (`0x0000`–`0xFFFF`).
- A word is 32-bit, **little-endian**.
- The stack grows downward (`PUSH` does `SP -= 4`).

## Encoding

Variable length. The first byte is the opcode; operands follow in the order
given by the ISA spec table. Operand kinds:

| Kind   | Size   | Contents                                        |
|--------|--------|-------------------------------------------------|
| `reg`  | 1 byte | register number (0–7)                           |
| `imm`  | 4 byte | immediate (little-endian 32-bit)                |
| `addr` | 4 byte | absolute address (labels resolved by assembler) |

The decoder and the assembler share the same table (`src/isa.ts`), so they can
never disagree on operand layout.

## Instructions

### Data movement
| Mnemonic | Operands  | Effect                          |
|----------|-----------|---------------------------------|
| `NOP`    | —         | nothing                         |
| `MOV`    | `rd, imm` | `rd = imm`                      |
| `MOVR`   | `rd, rs`  | `rd = rs`                       |
| `LOAD`   | `rd, addr`| `rd = mem32[addr]`              |
| `STORE`  | `rs, addr`| `mem32[addr] = rs`              |
| `LOADR`  | `rd, rs`  | `rd = mem32[rs]` (indirect)     |
| `STORER` | `rd, rs`  | `mem32[rd] = rs` (indirect)     |
| `LB`     | `rd, ra`  | `rd = mem8[ra]` (zero-extended) |
| `SB`     | `ra, rv`  | `mem8[ra] = rv & 0xff`          |

### Arithmetic / logic (update ZF/SF, and CF where applicable)
| Mnemonic              | Operands  | Effect                              |
|-----------------------|-----------|-------------------------------------|
| `ADD`                 | `rd, rs`  | `rd += rs`                          |
| `SUB`                 | `rd, rs`  | `rd -= rs`                          |
| `MUL`                 | `rd, rs`  | `rd *= rs` (low 32 bits)            |
| `DIV`                 | `rd, rs`  | `rd = floor(rd / rs)` (rs=0 faults) |
| `MOD`                 | `rd, rs`  | `rd = rd % rs` (rs=0 faults)        |
| `AND` `OR` `XOR`      | `rd, rs`  | bitwise                             |
| `NOT`                 | `rd`      | `rd = ~rd`                          |
| `SHL` `SHR`           | `rd, rs`  | shift left / logical right          |
| `INC` `DEC`           | `rd`      | `rd ± 1`                            |
| `CMP`                 | `rd, rs`  | `rd - rs`, flags only               |

### Control flow
| Mnemonic              | Operands | Condition                          |
|-----------------------|----------|------------------------------------|
| `JMP`                 | `addr`   | unconditional                      |
| `JZ` / `JNZ`          | `addr`   | `ZF==1` / `ZF==0`                  |
| `JG` `JGE` `JL` `JLE` | `addr`   | signed comparison (SF/ZF)          |
| `CALL`                | `addr`   | push `PC`, then jump               |
| `RET`                 | —        | pop `PC`                           |

### Stack
| Mnemonic | Operands | Effect                          |
|----------|----------|---------------------------------|
| `PUSH`   | `rs`     | `SP -= 4; mem32[SP] = rs`       |
| `POP`    | `rd`     | `rd = mem32[SP]; SP += 4`       |

### System
| Mnemonic | Operands | Effect                                          |
|----------|----------|-------------------------------------------------|
| `INT`    | `imm`    | soft interrupt; return to OS (`reason='int'`)   |
| `EI`/`DI`| —        | set / clear `IF`                                |
| `HLT`    | —        | stop the CPU (process end / idle)               |

### Privileged VM / trap control
| Mnemonic | Operands | Effect |
|----------|----------|--------|
| `IN` / `OUT` | `rd,rp` / `rp,rs` | port I/O |
| `LIDT` | `rs` | set the interrupt descriptor table base |
| `LKSP` | `rs` | set the kernel stack used on USER->KERNEL trap entry |
| `IRET` | — | return from an in-CPU trap frame |
| `RDPFLA` | `rd` | read the last page-fault linear address |
| `RDERR` | `rd` | read the last trap error code |
| `STMR` | `rs` | arm the in-CPU timer; IRQ0 fires every `rs` instructions |
| `LPTBR` | `rs` | set the page-directory base (`PTBR`/CR3) |
| `PGON` / `PGOFF` | — | enable / disable paging |

These instructions are privileged and trap if executed in USER mode.

## Assembler syntax

- One instruction per line; `;` or `#` starts a comment.
- Labels are `name:` (may share a line with an instruction).
- Registers are `R0`–`R7`.
- Immediates / addresses: decimal, `0x` hex, char literal `'A'`, or a label.
- Data directives: `.word v[,v...]` (32-bit words), `.string "..."` (NUL-terminated).
