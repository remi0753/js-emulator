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
import type { GReloc, Node, Obj, Program } from './parse.ts';
import { is64, isPointerLike, isPromotedUnsigned, isUnsignedInteger } from './type.ts';

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

  // Push a specific register onto the software stack; advance __csp by 4.
  private pushReg(reg: string): void {
    this.emit('  LOAD R5, __csp');
    this.emit(`  STORER R5, ${reg}`);
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
      this.emitInitData(this.data, obj.initData, obj.initRelocs ?? []);
      if (size > obj.initData.length) this.data.push(`  .space ${size - obj.initData.length}`);
      return;
    }
    this.bss.push(`${obj.name}:`);
    this.bss.push(`  .space ${size}`);
  }

  // Emit initializer data, splicing in `.word symbol+addend` at each relocation
  // slot (the assembler turns the symbol operand into an abs32 relocation) and
  // emitting the surrounding bytes as `.byte` runs.
  private emitInitData(out: string[], bytes: Uint8Array, relocs: GReloc[]): void {
    const sorted = [...relocs].sort((a, b) => a.offset - b.offset);
    let i = 0;
    let r = 0;
    while (i < bytes.length) {
      if (r < sorted.length && sorted[r]!.offset === i) {
        const { symbol, addend } = sorted[r]!;
        out.push(`  .word ${addend !== 0 ? `${symbol}+${addend}` : symbol}`);
        i += 4;
        r++;
        continue;
      }
      const end = r < sorted.length ? Math.min(bytes.length, sorted[r]!.offset) : bytes.length;
      for (let j = i; j < end; j += 16) {
        out.push(`  .byte ${[...bytes.slice(j, Math.min(j + 16, end))].join(',')}`);
      }
      i = end;
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
        this.genCond(node.cond!);
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
          this.genCond(node.cond);
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
      case 'do': {
        const top = this.label('do');
        const cont = this.label('do.cont');
        const end = this.label('do.end');
        this.breakStack.push(end);
        this.continueStack.push(cont);
        this.emit(`${top}:`);
        this.genStmt(node.thenStmt!);
        this.emit(`${cont}:`);
        this.genCond(node.cond!);
        this.emit('  MOV R7, 0');
        this.emit('  CMP R0, R7');
        this.emit(`  JNZ ${top}`);
        this.emit(`${end}:`);
        this.breakStack.pop();
        this.continueStack.pop();
        return;
      }
      case 'switch':
        this.genSwitch(node);
        return;
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

  private genSwitch(node: Node): void {
    const end = this.label('switch.end');
    const defaultLabel = node.defaultCase ? this.label('switch.default') : end;
    const labels = (node.cases ?? []).map((c) => ({ ...c, label: this.label('switch.case') }));

    this.genExpr(node.cond!);
    this.push();
    for (const c of labels) {
      this.pop('R0');
      this.push();
      this.emit(`  MOV R7, ${c.value >>> 0}`);
      this.emit('  CMP R0, R7');
      this.emit(`  JZ ${c.label}`);
    }
    this.pop('R0');
    this.emit(`  JMP ${defaultLabel}`);

    this.breakStack.push(end);
    for (const c of labels) {
      this.emit(`${c.label}:`);
      this.genStmt(c.body);
    }
    if (node.defaultCase) {
      this.emit(`${defaultLabel}:`);
      this.genStmt(node.defaultCase);
    }
    this.emit(`${end}:`);
    this.breakStack.pop();
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
      case 'member':
        this.genAddr(node.lhs!);
        if ((node.member?.offset ?? 0) > 0) {
          this.emit(`  MOV R7, ${node.member!.offset}`);
          this.emit('  ADD R0, R7');
        }
        return;
      default:
        throw new CodegenError(`not an lvalue (${node.kind})`);
    }
  }

  private load(node: Node): void {
    // Arrays decay to their address; everything else loads a value from [R0].
    if (node.ty?.kind === 'array') return;
    if (node.ty?.kind === 'func') return;
    if (node.ty?.kind === 'struct' || node.ty?.kind === 'union') {
      throw new CodegenError('cannot load an aggregate value directly');
    }
    if (node.ty?.kind === 'char')
      this.emit(`  ${isUnsignedInteger(node.ty) ? 'LB' : 'LBS'} R0, R0`);
    else if (node.ty?.kind === 'short')
      this.emit(`  ${isUnsignedInteger(node.ty) ? 'LH' : 'LHS'} R0, R0`);
    else this.emit('  LOADR R0, R0');
  }

  private store(node: Node): void {
    // Address in R1, value in R0.
    if (node.ty?.kind === 'char') this.emit('  SB R1, R0');
    else if (node.ty?.kind === 'short') this.emit('  SH R1, R0');
    else if (node.ty?.kind === 'struct' || node.ty?.kind === 'union') {
      throw new CodegenError('cannot assign an aggregate value directly');
    } else this.emit('  STORER R1, R0');
  }

  private genExpr(node: Node): void {
    // 64-bit values live in the R0(low):R1(high) pair and take a separate path.
    if (is64(node.ty)) {
      this.gen64Expr(node);
      return;
    }
    switch (node.kind) {
      case 'num':
        this.emit(`  MOV R0, ${node.value! >>> 0}`);
        return;
      case 'var':
        this.genAddr(node);
        this.load(node);
        return;
      case 'member':
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
      case 'cast':
        this.genExpr(node.lhs!);
        this.castTo(node.castType);
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
        this.genCond(node.lhs!);
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

  private castTo(ty: Node['ty']): void {
    if (!ty) return;
    if (ty.kind === 'char') {
      this.emit('  MOV R7, 255');
      this.emit('  AND R0, R7');
      if (!isUnsignedInteger(ty)) this.signExtend(0x80, 0xffffff00);
      return;
    }
    if (ty.kind === 'short') {
      this.emit('  MOV R7, 65535');
      this.emit('  AND R0, R7');
      if (!isUnsignedInteger(ty)) this.signExtend(0x8000, 0xffff0000);
    }
  }

  private signExtend(signBit: number, highBits: number): void {
    const done = this.label('sext.done');
    this.emit(`  MOV R7, ${signBit}`);
    this.emit('  CMP R0, R7');
    this.emit(`  JB ${done}`);
    this.emit(`  MOV R7, ${highBits >>> 0}`);
    this.emit('  OR R0, R7');
    this.emit(`${done}:`);
  }

  private genBinary(node: Node): void {
    // A comparison whose operands are 64-bit produces a 32-bit 0/1 result but
    // needs the full 64-bit compare helper.
    if (
      (node.kind === 'eq' || node.kind === 'ne' || node.kind === 'lt' || node.kind === 'le') &&
      (is64(node.lhs?.ty) || is64(node.rhs?.ty))
    ) {
      this.gen64Compare(node);
      return;
    }
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
        this.emit(`  ${isUnsignedInteger(node.ty) ? 'DIV' : 'IDIV'} R0, R1`);
        return;
      case 'mod':
        this.emit(`  ${isUnsignedInteger(node.ty) ? 'MOD' : 'IMOD'} R0, R1`);
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
        this.emit(`  ${isPromotedUnsigned(node.lhs?.ty) ? 'SHR' : 'SAR'} R0, R1`);
        return;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'le':
        this.genCompare(node);
        return;
      default:
        throw new CodegenError(`unsupported operator ${node.kind}`);
    }
  }

  private genCompare(node: Node): void {
    const yes = this.label('cmp.true');
    const done = this.label('cmp.done');
    // Signedness follows the usual arithmetic conversions: a comparison is
    // unsigned only when an operand is still unsigned after integer promotion.
    const unsigned = isPromotedUnsigned(node.lhs?.ty) || isPromotedUnsigned(node.rhs?.ty);
    const jump = {
      eq: 'JZ',
      ne: 'JNZ',
      lt: unsigned ? 'JB' : 'JL',
      le: unsigned ? 'JBE' : 'JLE',
    }[node.kind as 'eq' | 'ne' | 'lt' | 'le'];
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
    this.genCond(node.lhs!);
    this.emit('  MOV R7, 0');
    this.emit('  CMP R0, R7');
    this.emit(`  ${isAnd ? 'JZ' : 'JNZ'} ${set}`);
    this.genCond(node.rhs!);
    this.emit('  MOV R7, 0');
    this.emit('  CMP R0, R7');
    this.emit(`  ${isAnd ? 'JZ' : 'JNZ'} ${set}`);
    this.emit(`  MOV R0, ${isAnd ? 1 : 0}`);
    this.emit(`  JMP ${done}`);
    this.emit(`${set}:`);
    this.emit(`  MOV R0, ${isAnd ? 0 : 1}`);
    this.emit(`${done}:`);
  }

  // Evaluate a condition's truthiness into R0. A 64-bit operand folds both
  // words so a nonzero high word counts as true.
  private genCond(node: Node): void {
    this.genExpr(node);
    if (is64(node.ty)) this.emit('  OR R0, R1');
  }

  // --- 64-bit (long long) codegen -----------------------------------------
  //
  // A 64-bit value lives in R0 (low word) : R1 (high word). Arithmetic,
  // shifts, and comparisons go through the `__i64_*`/`__u64_*` runtime helpers
  // (see runtime64.ts), which take the operand words as ordinary 32-bit
  // arguments and return the 64-bit result in R0:R1 (compares return an int).
  // Helper arguments are pushed left-to-right, like any other call.

  // Map a 64-bit binary node to its runtime helper symbol.
  private helper64(node: Node): string {
    switch (node.kind) {
      case 'add':
        return '__i64_add';
      case 'sub':
        return '__i64_sub';
      case 'mul':
        return '__i64_mul';
      case 'div':
        return isUnsignedInteger(node.ty) ? '__u64_div' : '__i64_div';
      case 'mod':
        return isUnsignedInteger(node.ty) ? '__u64_mod' : '__i64_mod';
      case 'bitand':
        return '__i64_and';
      case 'bitor':
        return '__i64_or';
      case 'bitxor':
        return '__i64_xor';
      default:
        throw new CodegenError(`no 64-bit helper for ${node.kind}`);
    }
  }

  private gen64Expr(node: Node): void {
    switch (node.kind) {
      case 'num': {
        const v = node.value ?? 0;
        this.emit(`  MOV R0, ${v >>> 0}`);
        this.emit(`  MOV R1, ${Math.floor(v / 0x1_0000_0000) >>> 0}`);
        return;
      }
      case 'var':
      case 'member':
        this.genAddr(node);
        this.load64();
        return;
      case 'deref':
        this.genExpr(node.lhs!);
        this.load64();
        return;
      case 'assign':
        this.gen64Assign(node);
        return;
      case 'cast':
        this.genExpr(node.lhs!);
        if (!is64(node.lhs?.ty)) this.widen64(node.lhs?.ty);
        return;
      case 'funcall':
        this.genCall(node); // result returns in R0:R1
        return;
      case 'neg':
        this.gen64Unary(node.lhs!, '__i64_neg');
        return;
      case 'shl':
        this.gen64Shift(node, '__i64_shl');
        return;
      case 'shr':
        this.gen64Shift(node, isUnsignedInteger(node.ty) ? '__i64_shr' : '__i64_sar');
        return;
      default:
        this.gen64Binary(node, this.helper64(node));
    }
  }

  // Produce a 64-bit value in R0:R1 from any operand, widening narrower ones.
  private gen64Value(node: Node): void {
    if (is64(node.ty)) {
      this.genExpr(node);
      return;
    }
    this.genExpr(node);
    this.widen64(node.ty);
  }

  // Sign- or zero-extend a 32-bit value in R0 into the high word R1.
  private widen64(ty: Node['ty']): void {
    if (isUnsignedInteger(ty) || (ty && isPointerLike(ty))) {
      this.emit('  MOV R1, 0');
      return;
    }
    this.emit('  MOVR R1, R0');
    this.emit('  MOV R7, 31');
    this.emit('  SAR R1, R7');
  }

  // R0 = address -> load the 64-bit value at [R0] into R0:R1.
  private load64(): void {
    this.emit('  MOVR R2, R0');
    this.emit('  LOADR R0, R2');
    this.emit('  MOV R7, 4');
    this.emit('  ADD R2, R7');
    this.emit('  LOADR R1, R2');
  }

  private gen64Assign(node: Node): void {
    this.genAddr(node.lhs!);
    this.push(); // save destination address
    this.gen64Value(node.rhs!);
    this.pop('R2'); // R2 = address
    this.emit('  STORER R2, R0');
    this.emit('  MOV R7, 4');
    this.emit('  ADD R2, R7');
    this.emit('  STORER R2, R1');
  }

  // helper(a_lo, a_hi, b_lo, b_hi) -> R0:R1. Push left-to-right: a (low then
  // high), then b (low then high).
  private gen64Binary(node: Node, helper: string): void {
    this.gen64Value(node.lhs!);
    this.pushReg('R0'); // a_lo
    this.pushReg('R1'); // a_hi
    this.gen64Value(node.rhs!);
    this.pushReg('R0'); // b_lo
    this.pushReg('R1'); // b_hi
    this.emit(`  CALL ${helper}`);
    this.adjustCsp(-4 * 4);
  }

  // helper(v_lo, v_hi, amount) -> R0:R1
  private gen64Shift(node: Node, helper: string): void {
    this.gen64Value(node.lhs!);
    this.pushReg('R0'); // v_lo
    this.pushReg('R1'); // v_hi
    this.genExpr(node.rhs!); // shift amount (32-bit)
    this.push();
    this.emit(`  CALL ${helper}`);
    this.adjustCsp(-3 * 4);
  }

  // helper(v_lo, v_hi) -> R0:R1
  private gen64Unary(operand: Node, helper: string): void {
    this.gen64Value(operand);
    this.pushReg('R0'); // v_lo
    this.pushReg('R1'); // v_hi
    this.emit(`  CALL ${helper}`);
    this.adjustCsp(-2 * 4);
  }

  // helper(a_lo, a_hi, b_lo, b_hi) -> R0 = -1/0/1, turned into a 0/1 boolean.
  private gen64Compare(node: Node): void {
    const unsigned = isUnsignedInteger(node.lhs?.ty) || isUnsignedInteger(node.rhs?.ty);
    this.gen64Value(node.lhs!);
    this.pushReg('R0'); // a_lo
    this.pushReg('R1'); // a_hi
    this.gen64Value(node.rhs!);
    this.pushReg('R0'); // b_lo
    this.pushReg('R1'); // b_hi
    this.emit(`  CALL ${unsigned ? '__u64_cmp' : '__i64_cmp'}`);
    this.adjustCsp(-4 * 4);
    // R0 holds the signed comparison result; compare it against 0.
    const yes = this.label('cmp64.true');
    const done = this.label('cmp64.done');
    const jump = { eq: 'JZ', ne: 'JNZ', lt: 'JL', le: 'JLE' }[
      node.kind as 'eq' | 'ne' | 'lt' | 'le'
    ];
    this.emit('  MOV R7, 0');
    this.emit('  CMP R0, R7');
    this.emit(`  ${jump} ${yes}`);
    this.emit('  MOV R0, 0');
    this.emit(`  JMP ${done}`);
    this.emit(`${yes}:`);
    this.emit('  MOV R0, 1');
    this.emit(`${done}:`);
  }

  private genCall(node: Node): void {
    if (node.builtin) {
      this.genBuiltin(node);
      return;
    }
    // Arguments are pushed left-to-right, matching the bootstrap compiler's ABI
    // (chibicc objects link against bootstrap-compiled crt0/libc, so the two
    // must agree). A `long long` argument occupies two slots, low word first.
    const args = node.args ?? [];
    let words = 0;
    for (const arg of args) {
      if (is64(arg.ty)) {
        this.gen64Value(arg); // R0=low, R1=high
        this.pushReg('R0'); // low word (lower address)
        this.pushReg('R1'); // high word (higher address)
        words += 2;
      } else {
        this.genExpr(arg);
        this.push();
        words += 1;
      }
    }
    if (node.funcExpr) {
      this.genExpr(node.funcExpr);
      this.emit('  CALLR R0');
    } else {
      this.emit(`  CALL ${node.funcName}`);
    }
    if (words > 0) this.adjustCsp(-words * 4);
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
