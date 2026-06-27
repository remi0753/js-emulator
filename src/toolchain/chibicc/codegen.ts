// custom32 backend for the chibicc-derived frontend.
//
// This is the target-specific half of the compiler — the piece the roadmap's
// Phase 31 calls out as "the first custom32 backend slice". Everything before it
// (tokenize/preprocess/parse/type) is target independent; this file turns the
// typed AST into custom32 assembly that `as.ts` assembles and the object linker
// links.
//
// ABI: this slice emits the same software-stack convention the bootstrap
// compiler (`src/toolchain/c.ts`) uses, so chibicc objects link against the
// existing, tested `crt0Object()` startup/runtime and interoperate with the
// bootstrap libc:
//   - R0 is the expression accumulator; R1/R5/R7 are scratch.
//   - A software stack pointer `__csp` (a 4-byte global owned by crt0) holds C
//     arguments and locals; the hardware SP only carries return addresses.
//   - R6 is the frame base. Parameters sit at negative offsets (the caller
//     pushed them), locals at positive offsets.
//   - Arguments are pushed left-to-right; the caller pops them after the call.
// The hardware-SP ABI in docs/custom32-c-abi.md is the eventual target; moving
// to it is future work tracked in that document's migration notes.

import { SYSCALL_INT } from '../../isa.ts';
import type { Node, Obj, Program } from './parse.ts';

export class CodegenError extends Error {
  constructor(message: string) {
    super(`codegen error: ${message}`);
  }
}

class Generator {
  private readonly text: string[] = [];
  private readonly data: string[] = [];
  private readonly bss: string[] = [];
  private readonly globalDecls: string[] = [];
  private labelId = 0;
  private returnLabel = '';
  private readonly breakStack: string[] = [];
  private readonly continueStack: string[] = [];
  private readonly program: Program;

  constructor(program: Program) {
    this.program = program;
  }

  generate(): string {
    for (const obj of this.program.objects) {
      if (obj.isFunction) {
        if (obj.hasBody) this.genFunction(obj);
      } else {
        this.genGlobal(obj);
      }
    }

    const lines: string[] = [];
    for (const name of this.globalDecls) lines.push(`.global ${name}`);
    lines.push('.text');
    lines.push(...this.text);
    if (this.data.length > 0) {
      lines.push('.data');
      lines.push(...this.data);
    }
    if (this.bss.length > 0) {
      lines.push('.bss');
      lines.push(...this.bss);
    }
    return `${lines.join('\n')}\n`;
  }

  // --- emission helpers ----------------------------------------------------

  private emit(line: string): void {
    this.text.push(line);
  }

  private label(prefix: string): string {
    return `.L.${prefix}.${this.labelId++}`;
  }

  // Push R0 onto the software stack; advance __csp by 4.
  private push(): void {
    this.emit('  LOAD R5, __csp');
    this.emit('  STORER R5, R0');
    this.emit('  MOV R7, 4');
    this.emit('  ADD R5, R7');
    this.emit('  STORE R5, __csp');
  }

  // Pop the top software-stack slot into `reg`; retreat __csp by 4.
  private pop(reg: string): void {
    this.emit('  LOAD R5, __csp');
    this.emit('  MOV R7, 4');
    this.emit('  SUB R5, R7');
    this.emit('  STORE R5, __csp');
    this.emit(`  LOADR ${reg}, R5`);
  }

  private adjustCsp(delta: number): void {
    this.emit('  LOAD R5, __csp');
    this.emit(`  MOV R7, ${Math.abs(delta)}`);
    this.emit(delta >= 0 ? '  ADD R5, R7' : '  SUB R5, R7');
    this.emit('  STORE R5, __csp');
  }

  // --- globals -------------------------------------------------------------

  private genGlobal(obj: Obj): void {
    if (obj.isExtern) return; // pure declaration: storage lives elsewhere
    if (!obj.isStatic && !obj.isString) this.globalDecls.push(obj.name);

    const size = Math.max(1, obj.ty.size);
    if (obj.initData) {
      this.data.push(`${obj.name}:`);
      this.emitBytes(this.data, obj.initData);
      if (size > obj.initData.length) this.data.push(`  .space ${size - obj.initData.length}`);
      return;
    }
    this.bss.push(`${obj.name}:`);
    this.bss.push(`  .space ${size}`);
  }

  private emitBytes(out: string[], bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i += 16) {
      out.push(`  .byte ${[...bytes.slice(i, i + 16)].join(',')}`);
    }
  }

  // --- functions -----------------------------------------------------------

  private genFunction(fn: Obj): void {
    if (!fn.isStatic) this.globalDecls.push(fn.name);
    this.returnLabel = this.label(`${fn.name}.return`);

    this.emit(`${fn.name}:`);
    this.emit('  PUSH R6');
    this.emit('  LOAD R6, __csp');
    const stackSize = fn.stackSize ?? 0;
    if (stackSize > 0) {
      this.emit('  MOVR R5, R6');
      this.emit(`  MOV R7, ${stackSize}`);
      this.emit('  ADD R5, R7');
      this.emit('  STORE R5, __csp');
    }

    if (fn.bodyNode) this.genStmt(fn.bodyNode);

    // A function that falls off its end returns 0, matching C's `main` rule and
    // keeping a defined value in R0.
    this.emit('  MOV R0, 0');
    this.emit(`${this.returnLabel}:`);
    this.emit('  STORE R6, __csp');
    this.emit('  POP R6');
    this.emit('  RET');
  }

  // --- statements ----------------------------------------------------------

  private genStmt(node: Node): void {
    switch (node.kind) {
      case 'block':
        for (const s of node.body ?? []) this.genStmt(s);
        return;
      case 'exprstmt':
        if (node.lhs) this.genExpr(node.lhs);
        return;
      case 'return':
        if (node.lhs) this.genExpr(node.lhs);
        else this.emit('  MOV R0, 0');
        this.emit(`  JMP ${this.returnLabel}`);
        return;
      case 'if': {
        const els = this.label('else');
        const end = this.label('endif');
        this.genExpr(node.cond!);
        this.emit('  MOV R7, 0');
        this.emit('  CMP R0, R7');
        this.emit(`  JZ ${els}`);
        this.genStmt(node.thenStmt!);
        this.emit(`  JMP ${end}`);
        this.emit(`${els}:`);
        if (node.els) this.genStmt(node.els);
        this.emit(`${end}:`);
        return;
      }
      case 'for': {
        const top = this.label('loop');
        const cont = this.label('cont');
        const end = this.label('endloop');
        if (node.init) this.genStmt(node.init);
        this.breakStack.push(end);
        this.continueStack.push(cont);
        this.emit(`${top}:`);
        if (node.cond) {
          this.genExpr(node.cond);
          this.emit('  MOV R7, 0');
          this.emit('  CMP R0, R7');
          this.emit(`  JZ ${end}`);
        }
        this.genStmt(node.thenStmt!);
        this.emit(`${cont}:`);
        if (node.inc) this.genExpr(node.inc);
        this.emit(`  JMP ${top}`);
        this.emit(`${end}:`);
        this.breakStack.pop();
        this.continueStack.pop();
        return;
      }
      case 'break': {
        const target = this.breakStack.at(-1);
        if (!target) throw new CodegenError('break outside a loop');
        this.emit(`  JMP ${target}`);
        return;
      }
      case 'continue': {
        const target = this.continueStack.at(-1);
        if (!target) throw new CodegenError('continue outside a loop');
        this.emit(`  JMP ${target}`);
        return;
      }
      default:
        // Any other node used in statement position is an expression.
        this.genExpr(node);
    }
  }

  // --- expressions ---------------------------------------------------------

  // Evaluate the address of an lvalue into R0.
  private genAddr(node: Node): void {
    switch (node.kind) {
      case 'var': {
        const obj = node.variable!;
        if (obj.isLocal) {
          const offset = obj.offset ?? 0;
          this.emit('  MOVR R0, R6');
          if (offset > 0) {
            this.emit(`  MOV R7, ${offset}`);
            this.emit('  ADD R0, R7');
          } else if (offset < 0) {
            this.emit(`  MOV R7, ${-offset}`);
            this.emit('  SUB R0, R7');
          }
        } else {
          this.emit(`  MOV R0, ${obj.name}`);
        }
        return;
      }
      case 'deref':
        this.genExpr(node.lhs!);
        return;
      default:
        throw new CodegenError(`not an lvalue (${node.kind})`);
    }
  }

  private load(node: Node): void {
    // Arrays decay to their address; everything else loads a value from [R0].
    if (node.ty?.kind === 'array') return;
    if (node.ty?.kind === 'char') this.emit('  LB R0, R0');
    else this.emit('  LOADR R0, R0');
  }

  private store(node: Node): void {
    // Address in R1, value in R0.
    if (node.ty?.kind === 'char') this.emit('  SB R1, R0');
    else this.emit('  STORER R1, R0');
  }

  private genExpr(node: Node): void {
    switch (node.kind) {
      case 'num':
        this.emit(`  MOV R0, ${node.value! >>> 0}`);
        return;
      case 'var':
        this.genAddr(node);
        this.load(node);
        return;
      case 'addr':
        this.genAddr(node.lhs!);
        return;
      case 'deref':
        this.genExpr(node.lhs!);
        this.load(node);
        return;
      case 'assign':
        this.genAddr(node.lhs!);
        this.push();
        this.genExpr(node.rhs!);
        this.pop('R1');
        this.store(node.lhs!);
        return;
      case 'funcall':
        this.genCall(node);
        return;
      case 'neg':
        this.genExpr(node.lhs!);
        this.emit('  MOV R1, 0');
        this.emit('  SUB R1, R0');
        this.emit('  MOVR R0, R1');
        return;
      case 'not': {
        const yes = this.label('not.true');
        const done = this.label('not.done');
        this.genExpr(node.lhs!);
        this.emit('  MOV R7, 0');
        this.emit('  CMP R0, R7');
        this.emit(`  JZ ${yes}`);
        this.emit('  MOV R0, 0');
        this.emit(`  JMP ${done}`);
        this.emit(`${yes}:`);
        this.emit('  MOV R0, 1');
        this.emit(`${done}:`);
        return;
      }
      case 'logand':
      case 'logor':
        this.genLogical(node);
        return;
      default:
        this.genBinary(node);
    }
  }

  private genBinary(node: Node): void {
    // Evaluate rhs first and stash it, then lhs, so R0 = lhs and R1 = rhs.
    this.genExpr(node.rhs!);
    this.push();
    this.genExpr(node.lhs!);
    this.pop('R1');

    switch (node.kind) {
      case 'add':
        this.emit('  ADD R0, R1');
        return;
      case 'sub':
        this.emit('  SUB R0, R1');
        return;
      case 'mul':
        this.emit('  MUL R0, R1');
        return;
      case 'div':
        this.emit('  IDIV R0, R1');
        return;
      case 'mod':
        this.emit('  IMOD R0, R1');
        return;
      case 'bitand':
        this.emit('  AND R0, R1');
        return;
      case 'bitor':
        this.emit('  OR R0, R1');
        return;
      case 'bitxor':
        this.emit('  XOR R0, R1');
        return;
      case 'shl':
        this.emit('  SHL R0, R1');
        return;
      case 'shr':
        this.emit('  SAR R0, R1');
        return;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'le':
        this.genCompare(node.kind);
        return;
      default:
        throw new CodegenError(`unsupported operator ${node.kind}`);
    }
  }

  private genCompare(kind: 'eq' | 'ne' | 'lt' | 'le'): void {
    const yes = this.label('cmp.true');
    const done = this.label('cmp.done');
    const jump = { eq: 'JZ', ne: 'JNZ', lt: 'JL', le: 'JLE' }[kind];
    this.emit('  CMP R0, R1');
    this.emit(`  ${jump} ${yes}`);
    this.emit('  MOV R0, 0');
    this.emit(`  JMP ${done}`);
    this.emit(`${yes}:`);
    this.emit('  MOV R0, 1');
    this.emit(`${done}:`);
  }

  // Short-circuit && / ||, normalized to 0/1.
  private genLogical(node: Node): void {
    const isAnd = node.kind === 'logand';
    const set = this.label('logic.set');
    const done = this.label('logic.done');
    this.genExpr(node.lhs!);
    this.emit('  MOV R7, 0');
    this.emit('  CMP R0, R7');
    this.emit(`  ${isAnd ? 'JZ' : 'JNZ'} ${set}`);
    this.genExpr(node.rhs!);
    this.emit('  MOV R7, 0');
    this.emit('  CMP R0, R7');
    this.emit(`  ${isAnd ? 'JZ' : 'JNZ'} ${set}`);
    this.emit(`  MOV R0, ${isAnd ? 1 : 0}`);
    this.emit(`  JMP ${done}`);
    this.emit(`${set}:`);
    this.emit(`  MOV R0, ${isAnd ? 0 : 1}`);
    this.emit(`${done}:`);
  }

  private genCall(node: Node): void {
    if (node.builtin) {
      this.genBuiltin(node);
      return;
    }
    const args = node.args ?? [];
    for (const arg of args) {
      this.genExpr(arg);
      this.push();
    }
    this.emit(`  CALL ${node.funcName}`);
    if (args.length > 0) this.adjustCsp(-args.length * 4);
  }

  // Target intrinsics. The slice supports `__syscall` (the userland trap) plus a
  // few raw device/CPU primitives; the full builtin set follows in later phases.
  private genBuiltin(node: Node): void {
    const args = node.args ?? [];
    const intoRegs = (regs: string[]): void => {
      for (const arg of args) {
        this.genExpr(arg);
        this.emit('  PUSH R0');
      }
      for (let i = Math.min(args.length, regs.length) - 1; i >= 0; i--) {
        this.emit(`  POP ${regs[i]}`);
      }
      for (let i = args.length; i < regs.length; i++) this.emit(`  MOV ${regs[i]}, 0`);
    };

    switch (node.builtin) {
      case '__syscall':
        intoRegs(['R0', 'R1', 'R2', 'R3']);
        this.emit(`  INT ${SYSCALL_INT}`);
        return;
      case '__out':
        intoRegs(['R1', 'R2']);
        this.emit('  OUT R1, R2');
        this.emit('  MOV R0, 0');
        return;
      case '__in':
        intoRegs(['R1']);
        this.emit('  IN R0, R1');
        return;
      case '__halt':
        this.emit('  HLT');
        this.emit('  MOV R0, 0');
        return;
      default:
        throw new CodegenError(`unknown builtin ${node.builtin}`);
    }
  }
}

export function generate(program: Program): string {
  return new Generator(program).generate();
}
