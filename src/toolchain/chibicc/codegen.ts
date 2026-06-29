// custom32 backend for the chibicc-derived frontend.
//
// This is the target-specific half of the compiler — the piece the roadmap's
// Phase 31 calls out as "the first custom32 backend slice". Everything before it
// (tokenize/preprocess/parse/type) is target independent; this file turns the
// typed AST into custom32 assembly that `as.ts` assembles and the object linker
// links.
//
// ABI: this slice emits the custom32 software-stack convention used by the
// maintained guest toolchain, so chibicc objects link against the shared
// `crt0Object()`/`kernelCrt0Object()` startup and runtime helpers:
//   - R0 is the expression accumulator; R1/R5/R7 are scratch.
//   - A software stack pointer `__csp` (a 4-byte global owned by crt0) holds C
//     arguments and locals; the hardware SP only carries return addresses.
//   - R6 is the frame base. Parameters sit at negative offsets (the caller
//     pushed them), locals at positive offsets.
//   - Arguments are pushed right-to-left; the caller pops them after the call.
// The hardware-SP ABI in docs/custom32-c-abi.md is the eventual target; moving
// to it is future work tracked in that document's migration notes.

import { SYSCALL_INT } from '../../isa.ts';
import type { GReloc, Node, Obj, Program } from './parse.ts';
import {
  elementType,
  is64,
  isAggregate,
  isFloating,
  isPointerLike,
  isPromotedUnsigned,
  isUnsignedInteger,
} from './type.ts';

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
  private currentFn: Obj | null = null;
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

  // Whether R5 currently holds the value of the `__csp` global. The stack
  // helpers reload __csp into R5 on every push/pop; tracking this lets them skip
  // the reload when R5 already holds it (the common case in a straight run of
  // pushes), which removes a large fraction of the memory traffic in the naive
  // stack-machine output.
  private r5HasCsp = false;

  // Whether R5 holds a newer `__csp` value than the in-memory global — i.e. a
  // push/pop/adjust advanced R5 but deferred the `STORE R5, __csp` write-back.
  // The stack machine round-trips __csp through memory on every push/pop; keeping
  // the live value in R5 and only reconciling memory at the points that actually
  // read __csp (calls, traps, control-flow joins, explicit __csp access) removes
  // most of that traffic. Invariant: cspMemStale implies r5HasCsp — when R5 holds
  // the only current copy of __csp it must never be clobbered before a flush.
  private cspMemStale = false;

  private emit(line: string): void {
    const t = line.trim();
    // Reconcile a deferred __csp before any instruction that needs it current in
    // memory: a control-flow boundary (label/branch/return), a call or trap (the
    // callee or kernel reads __csp), or an explicit __csp access.
    if (this.cspMemStale && this.needsCspFlush(t)) this.flushCsp();
    this.text.push(line);
    // Conservatively forget the R5==__csp fact whenever a line could change R5
    // or __csp, reach a control-flow join (label), or clobber R5 via a call/trap.
    // Only straight-line instructions that touch neither R5 nor __csp preserve
    // it. The csp helpers re-assert the fact after emitting their sequence.
    if (this.r5HasCsp) {
      if (
        t.endsWith(':') ||
        /\bR5\b/.test(t) ||
        /\b__csp\b/.test(t) ||
        /^(CALL|CALLR|INT)\b/.test(t)
      ) {
        this.r5HasCsp = false;
      }
    }
  }

  // Whether `__csp` must be current in memory before the given (trimmed) line.
  private needsCspFlush(t: string): boolean {
    return (
      t.endsWith(':') ||
      /^(CALL|CALLR|INT|IRET|RET)\b/.test(t) ||
      /^J[A-Z]+\b/.test(t) ||
      /\b__csp\b/.test(t)
    );
  }

  // Write the deferred software-stack pointer back from R5 to the __csp global.
  private flushCsp(): void {
    if (!this.cspMemStale) return;
    this.cspMemStale = false;
    this.emit('  STORE R5, __csp');
    this.r5HasCsp = true; // R5 still holds __csp; memory is current again
  }

  // Load __csp into R5, skipping the load when R5 already holds it.
  private loadCsp(): void {
    if (!this.r5HasCsp) this.emit('  LOAD R5, __csp');
    this.r5HasCsp = true;
  }

  private label(prefix: string): string {
    return `.L.${prefix}.${this.labelId++}`;
  }

  // Push R0 onto the software stack; advance __csp by 4.
  private push(): void {
    this.loadCsp();
    this.emit('  STORER R5, R0');
    this.emit('  MOV R7, 4');
    this.emit('  ADD R5, R7');
    // Defer the `STORE R5, __csp`: R5 holds the live __csp, memory lags until the
    // next flush point. A straight run of pushes keeps advancing R5 in place.
    this.cspMemStale = true;
    this.r5HasCsp = true;
  }

  // Push a specific register onto the software stack; advance __csp by 4.
  private pushReg(reg: string): void {
    this.loadCsp();
    this.emit(`  STORER R5, ${reg}`);
    this.emit('  MOV R7, 4');
    this.emit('  ADD R5, R7');
    this.cspMemStale = true;
    this.r5HasCsp = true;
  }

  // Pop the top software-stack slot into `reg`; retreat __csp by 4.
  private pop(reg: string): void {
    this.loadCsp();
    this.emit('  MOV R7, 4');
    this.emit('  SUB R5, R7');
    if (reg === 'R5') {
      // The load overwrites R5, so the retreated __csp must reach memory first.
      this.emit('  STORE R5, __csp');
      this.emit('  LOADR R5, R5');
      this.cspMemStale = false;
      this.r5HasCsp = false;
      return;
    }
    this.cspMemStale = true; // R5 keeps the live __csp; defer the write-back
    this.emit(`  LOADR ${reg}, R5`);
    this.r5HasCsp = true;
  }

  // Expression temporaries are routed through helpers so the C-source guest
  // backend can use a different strategy while the bootstrap backend stays on
  // the conservative software-stack ABI. The bootstrap output includes the
  // soft-float and i64 runtimes, whose deep helper nesting is deliberately kept
  // on the older path.
  private pushTemp(reg = 'R0'): void {
    if (reg === 'R0') this.push();
    else this.pushReg(reg);
  }

  private popTemp(reg: string): void {
    this.pop(reg);
  }

  private adjustCsp(delta: number): void {
    this.loadCsp();
    this.emit(`  MOV R7, ${Math.abs(delta)}`);
    this.emit(delta >= 0 ? '  ADD R5, R7' : '  SUB R5, R7');
    this.cspMemStale = true;
    this.r5HasCsp = true;
  }

  private slotSize(ty: Node['ty']): number {
    return Math.floor((Math.max(1, ty?.size ?? 4) + 3) / 4) * 4;
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
    this.currentFn = fn;
    this.cspMemStale = false;
    this.r5HasCsp = false;
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
    this.currentFn = null;
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
        if (node.lhs && isAggregate(this.currentFn?.ty.returnType)) {
          this.returnAggregate(node.lhs);
        } else if (node.lhs) this.genValueAs(node.lhs, this.currentFn?.ty.returnType);
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
      case 'asm':
        // Inline asm may use R5 as scratch; reconcile any deferred __csp first.
        this.flushCsp();
        for (const line of (node.asmSource ?? '').split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          const label = /^([A-Za-z_.][\w.]*)\s*:$/.exec(trimmed);
          if (label) this.emit(`.global ${label[1]}`);
          this.emit(`  ${trimmed}`);
        }
        return;
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
    this.pushTemp();
    for (const c of labels) {
      this.popTemp('R0');
      this.pushTemp();
      this.emit(`  MOV R7, ${c.value >>> 0}`);
      this.emit('  CMP R0, R7');
      this.emit(`  JZ ${c.label}`);
    }
    this.popTemp('R0');
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
      case 'compoundlit':
        this.genCompoundLiteral(node);
        this.genAddr({ kind: 'var', line: node.line, variable: node.variable, ty: node.ty });
        return;
      case 'funcall':
        if (isAggregate(node.ty)) {
          this.genCall(node);
          return;
        }
        break;
      case 'vaarg':
        if (isAggregate(node.ty)) {
          this.genVaArg(node);
          return;
        }
        break;
      default:
        break;
    }
    throw new CodegenError(`not an lvalue (${node.kind})`);
  }

  private load(node: Node): void {
    // Arrays decay to their address; everything else loads a value from [R0].
    if (node.ty?.kind === 'array') {
      if (node.ty.isVLA) this.emit('  LOADR R0, R0');
      return;
    }
    if (node.ty?.kind === 'func') return;
    if (node.kind === 'member' && node.member?.bitWidth !== undefined) {
      this.loadBitField(node.member);
      return;
    }
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
    if (node.kind === 'member' && node.member?.bitWidth !== undefined) {
      this.storeBitField(node.member);
      return;
    }
    if (node.ty?.kind === 'char') this.emit('  SB R1, R0');
    else if (node.ty?.kind === 'short') this.emit('  SH R1, R0');
    else if (node.ty?.kind === 'struct' || node.ty?.kind === 'union') {
      throw new CodegenError('cannot assign an aggregate value directly');
    } else this.emit('  STORER R1, R0');
  }

  private bitMask(width: number): number {
    return width >= 32 ? 0xffffffff : (2 ** width - 1) >>> 0;
  }

  private loadBitField(member: NonNullable<Node['member']>): void {
    const width = member.bitWidth ?? 0;
    const bit = member.bitOffset ?? 0;
    const mask = this.bitMask(width);
    this.emit('  LOADR R0, R0');
    if (bit > 0) {
      this.emit(`  MOV R7, ${bit}`);
      this.emit('  SHR R0, R7');
    }
    this.emit(`  MOV R7, ${mask >>> 0}`);
    this.emit('  AND R0, R7');
    if (!isUnsignedInteger(member.ty) && width > 0 && width < 32) {
      this.signExtend(1 << (width - 1), ~mask >>> 0);
    }
  }

  private storeBitField(member: NonNullable<Node['member']>): void {
    const width = member.bitWidth ?? 0;
    const bit = member.bitOffset ?? 0;
    const mask = this.bitMask(width);
    const shiftedMask = bit === 0 ? mask : (mask << bit) >>> 0;
    const clearMask = ~shiftedMask >>> 0;
    // Uses R5 as scratch; flush any deferred __csp held in R5 first.
    this.flushCsp();
    this.emit('  MOVR R2, R0');
    this.emit('  LOADR R0, R1');
    this.emit(`  MOV R7, ${clearMask}`);
    this.emit('  AND R0, R7');
    this.emit('  MOVR R5, R2');
    this.emit(`  MOV R7, ${mask >>> 0}`);
    this.emit('  AND R5, R7');
    if (bit > 0) {
      this.emit(`  MOV R7, ${bit}`);
      this.emit('  SHL R5, R7');
    }
    this.emit('  OR R0, R5');
    this.emit('  STORER R1, R0');
    this.emit('  MOVR R0, R2');
  }

  // Copy exactly `size` bytes from R0 (source address) to R1 (destination
  // address). R0/R1 are not preserved; callers decide the expression result.
  private copyBytes(size: number): void {
    // Uses R5 as the scratch destination pointer; flush any deferred __csp first.
    this.flushCsp();
    this.emit('  MOVR R2, R0');
    this.emit('  MOVR R5, R1');
    let remaining = size;
    while (remaining >= 4) {
      this.emit('  LOADR R7, R2');
      this.emit('  STORER R5, R7');
      this.emit('  MOV R7, 4');
      this.emit('  ADD R2, R7');
      this.emit('  ADD R5, R7');
      remaining -= 4;
    }
    while (remaining > 0) {
      this.emit('  LB R7, R2');
      this.emit('  SB R5, R7');
      this.emit('  MOV R7, 1');
      this.emit('  ADD R2, R7');
      this.emit('  ADD R5, R7');
      remaining--;
    }
  }

  private genAggregateAssign(node: Node): void {
    const size = Math.max(1, node.lhs?.ty?.size ?? 1);
    this.genAddr(node.lhs!);
    this.pushTemp();
    this.genAddr(node.rhs!);
    this.popTemp('R1');
    this.copyBytes(size);
    this.emit('  MOVR R0, R1');
  }

  private returnAggregate(expr: Node): void {
    const fn = this.currentFn;
    const size = Math.max(1, fn?.ty.returnType?.size ?? expr.ty?.size ?? 1);
    const offset = fn?.returnBufferOffset;
    if (offset === undefined) throw new CodegenError('aggregate return without a return buffer');
    this.emit('  MOVR R1, R6');
    this.emit(`  MOV R7, ${-offset}`);
    this.emit('  SUB R1, R7');
    this.emit('  LOADR R1, R1');
    this.pushTemp('R1');
    this.genAddr(expr);
    this.popTemp('R1');
    this.copyBytes(size);
    this.emit('  MOVR R0, R1');
  }

  private genCompoundLiteral(node: Node): void {
    for (const stmt of node.initStmts ?? []) this.genStmt(stmt);
  }

  private genVlaAlloc(node: Node): void {
    const elemSize = Math.max(1, elementType(node.variable!.ty).size);
    this.genExpr(node.vlaLen!);
    if (elemSize !== 1) {
      this.emit(`  MOV R7, ${elemSize}`);
      this.emit('  MUL R0, R7');
    }
    this.pushTemp();
    this.genAddr({ kind: 'var', line: node.line, variable: node.vlaSizeObj });
    this.popTemp('R7');
    this.emit('  STORER R0, R7');
    this.emit('  LOAD R7, __csp');
    this.pushTemp('R7');
    this.genAddr({ kind: 'var', line: node.line, variable: node.variable });
    this.popTemp('R7');
    this.emit('  STORER R0, R7');
    this.genExpr({ kind: 'var', line: node.line, variable: node.vlaSizeObj });
    this.emit('  MOV R7, 3');
    this.emit('  ADD R0, R7');
    this.emit('  MOV R7, 4294967292');
    this.emit('  AND R0, R7');
    this.emit('  LOAD R5, __csp');
    this.emit('  ADD R5, R0');
    this.emit('  STORE R5, __csp');
  }

  private genVaStart(node: Node): void {
    this.genAddr(node.vaList!);
    this.pushTemp();
    this.genAddr({
      kind: 'var',
      line: node.line,
      variable: node.vaParam,
      ty: node.vaParam?.ty,
    });
    this.popTemp('R1');
    this.emit('  STORER R1, R0');
    this.emit('  MOV R0, 0');
  }

  // With the current upward-growing software stack, right-to-left calls place
  // variadic arguments below the fixed arguments. `va_list` therefore stores a
  // boundary pointer and each `va_arg` pre-decrements it by the requested slot.
  private advanceVaList(node: Node): void {
    const size = this.slotSize(node.castType);
    this.genAddr(node.vaList!);
    this.pushTemp(); // address of the va_list object
    this.emit('  LOADR R0, R0');
    this.emit(`  MOV R7, ${size}`);
    this.emit('  SUB R0, R7');
    this.emit('  MOVR R2, R0');
    this.popTemp('R1');
    this.emit('  STORER R1, R2');
    this.emit('  MOVR R0, R2');
  }

  private genVaArg(node: Node): void {
    this.advanceVaList(node);
    if (isAggregate(node.castType)) {
      if (!node.variable) throw new CodegenError('aggregate va_arg without a temporary');
      this.pushTemp();
      this.genAddr({ kind: 'var', line: node.line, variable: node.variable, ty: node.variable.ty });
      this.emit('  MOVR R1, R0');
      this.popTemp('R0');
      this.copyBytes(Math.max(1, node.castType?.size ?? 1));
      this.genAddr({ kind: 'var', line: node.line, variable: node.variable, ty: node.variable.ty });
      return;
    }
    if (is64(node.castType)) {
      this.load64();
      return;
    }
    if (node.castType?.kind === 'double') {
      this.load64();
      return;
    }
    this.load({ kind: 'deref', line: node.line, lhs: node.vaList, ty: node.castType });
  }

  private genExpr(node: Node): void {
    // The comma operator and `?:` are evaluated before the value-type routing
    // below so their result width is decided by the arm that produces it.
    if (node.kind === 'comma') {
      this.genExpr(node.lhs!);
      this.genExpr(node.rhs!);
      return;
    }
    if (node.kind === 'cond') {
      this.genConditional(node);
      return;
    }
    // 64-bit values live in the R0(low):R1(high) pair and take a separate path.
    if (is64(node.ty)) {
      this.gen64Expr(node);
      return;
    }
    if (node.ty?.kind === 'float') {
      this.genFloatExpr(node);
      return;
    }
    if (node.ty?.kind === 'double') {
      this.genDoubleExpr(node);
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
      case 'compoundlit':
        this.genCompoundLiteral(node);
        this.genAddr({ kind: 'var', line: node.line, variable: node.variable, ty: node.ty });
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
        if (isAggregate(node.lhs?.ty)) {
          this.genAggregateAssign(node);
          return;
        }
        this.genAddr(node.lhs!);
        if (this.valueIsSimple(node.rhs!)) {
          // Hold the destination address in R1 while a simple rhs recomputes
          // R0, skipping the software-stack round-trip. store() wants R1=addr.
          this.emit('  MOVR R1, R0');
          this.genExpr(node.rhs!);
        } else {
          this.pushTemp();
          this.genExpr(node.rhs!);
          this.popTemp('R1');
        }
        this.store(node.lhs!);
        return;
      case 'vlaalloc':
        this.genVlaAlloc(node);
        return;
      case 'vastart':
        this.genVaStart(node);
        return;
      case 'vaarg':
        this.genVaArg(node);
        return;
      case 'funcall':
        this.genCall(node);
        return;
      case 'cast':
        this.genValueAs(node.lhs!, node.castType);
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

  private genValueAs(node: Node, ty: Node['ty']): void {
    if (!ty) {
      this.genExpr(node);
      return;
    }
    if (ty.kind === 'float') {
      this.genFloatValue(node);
      return;
    }
    if (ty.kind === 'double') {
      this.genDoubleValue(node);
      return;
    }
    if (is64(ty)) {
      this.gen64Value(node);
      return;
    }
    if (node.ty?.kind === 'float') {
      this.genFloatValue(node);
      this.push();
      this.emit('  CALL __fixsfsi');
      this.adjustCsp(-1 * 4);
      return;
    }
    if (node.ty?.kind === 'double') {
      this.genDoubleValue(node);
      this.pushReg('R1');
      this.pushReg('R0');
      this.emit('  CALL __fixdfsi');
      this.adjustCsp(-2 * 4);
      return;
    }
    this.genExpr(node);
    this.castTo(ty);
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

  // A plain 32-bit integer constant: `MOV R0/R1, value` reproduces it with no
  // stack traffic. Excludes float/64-bit literals, which take other paths.
  private isIntConst(node: Node): boolean {
    return node.kind === 'num' && !isFloating(node.ty) && !is64(node.ty);
  }

  private isCommutative(kind: Node['kind']): boolean {
    return kind === 'add' || kind === 'mul' || kind === 'bitand' || kind === 'bitor' || kind === 'bitxor';
  }

  // True when genExpr(node) writes only R0 and the R7 scratch — never R1-R5. A
  // simple value can be (re)computed while another operand is held live in R1,
  // removing the software-stack spill/reload around a binary operator.
  private valueIsSimple(node: Node): boolean {
    if (isFloating(node.ty) || is64(node.ty)) return false;
    switch (node.kind) {
      case 'num':
      case 'var':
        return true;
      case 'member':
        return node.member?.bitWidth === undefined && this.addrIsSimple(node);
      case 'deref':
        return this.valueIsSimple(node.lhs!);
      case 'addr':
        return this.addrIsSimple(node.lhs!);
      default:
        return false;
    }
  }

  // True when genAddr(node) writes only R0 and the R7 scratch.
  private addrIsSimple(node: Node): boolean {
    switch (node.kind) {
      case 'var':
        return true;
      case 'member':
        return node.member?.bitWidth === undefined && this.addrIsSimple(node.lhs!);
      case 'deref':
        return this.valueIsSimple(node.lhs!);
      default:
        return false;
    }
  }

  private genBinary(node: Node): void {
    if (
      (node.kind === 'eq' || node.kind === 'ne' || node.kind === 'lt' || node.kind === 'le') &&
      (isFloating(node.lhs?.ty) || isFloating(node.rhs?.ty))
    ) {
      this.genFloatCompare(node);
      return;
    }
    // A comparison whose operands are 64-bit produces a 32-bit 0/1 result but
    // needs the full 64-bit compare helper.
    if (
      (node.kind === 'eq' || node.kind === 'ne' || node.kind === 'lt' || node.kind === 'le') &&
      (is64(node.lhs?.ty) || is64(node.rhs?.ty))
    ) {
      this.gen64Compare(node);
      return;
    }
    // The operator switch below expects lhs in R0 and rhs in R1. The general
    // way to get there is to evaluate rhs, spill it to the software stack,
    // evaluate lhs, then reload rhs — two memory round-trips. The fast paths
    // below avoid the spill whenever an operand is a constant (fold it straight
    // into R1) or the left operand is a simple leaf that provably touches only
    // R0/R7, so a previously computed rhs can stay live in R1.
    const lhs = node.lhs!;
    const rhs = node.rhs!;
    if (this.isIntConst(rhs)) {
      this.genExpr(lhs);
      this.emit(`  MOV R1, ${(rhs.value ?? 0) >>> 0}`);
    } else if (this.isIntConst(lhs) && this.isCommutative(node.kind)) {
      this.genExpr(rhs);
      this.emit(`  MOV R1, ${(lhs.value ?? 0) >>> 0}`);
    } else if (this.valueIsSimple(lhs)) {
      this.genExpr(rhs);
      this.emit('  MOVR R1, R0');
      this.genExpr(lhs);
    } else {
      // Evaluate rhs first and stash it, then lhs, so R0 = lhs and R1 = rhs.
      this.genExpr(rhs);
      this.pushTemp();
      this.genExpr(lhs);
      this.popTemp('R1');
    }

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
  // `cond ? then : els`. Both arms are generated with their own value type so a
  // 64-bit or float result lands in the right register(s).
  private genConditional(node: Node): void {
    const els = this.label('cond.else');
    const end = this.label('cond.end');
    this.genCond(node.cond!);
    this.emit('  MOV R7, 0');
    this.emit('  CMP R0, R7');
    this.emit(`  JZ ${els}`);
    this.genExpr(node.thenStmt!);
    this.emit(`  JMP ${end}`);
    this.emit(`${els}:`);
    this.genExpr(node.els!);
    this.emit(`${end}:`);
  }

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
    else if (node.ty?.kind === 'float') {
      this.emit('  MOV R7, 2147483647');
      this.emit('  AND R0, R7');
    } else if (node.ty?.kind === 'double') {
      this.emit('  MOV R7, 2147483647');
      this.emit('  AND R1, R7');
      this.emit('  OR R0, R1');
    }
  }

  // --- soft-float codegen --------------------------------------------------

  private floatBinaryHelper(node: Node, prefix: 'sf' | 'df'): string {
    const suffix = prefix === 'sf' ? 'sf3' : 'df3';
    switch (node.kind) {
      case 'add':
        return `__add${suffix}`;
      case 'sub':
        return `__sub${suffix}`;
      case 'mul':
        return `__mul${suffix}`;
      case 'div':
        return `__div${suffix}`;
      default:
        throw new CodegenError(`no soft-float helper for ${node.kind}`);
    }
  }

  private genFloatExpr(node: Node): void {
    switch (node.kind) {
      case 'num':
        this.emit(`  MOV R0, ${node.value! >>> 0}`);
        return;
      case 'var':
      case 'member':
        this.genAddr(node);
        this.load(node);
        return;
      case 'deref':
        this.genExpr(node.lhs!);
        this.load(node);
        return;
      case 'assign':
        this.genAddr(node.lhs!);
        this.pushTemp();
        this.genFloatValue(node.rhs!);
        this.popTemp('R1');
        this.store(node.lhs!);
        return;
      case 'cast':
        this.genFloatValue(node.lhs!);
        return;
      case 'funcall':
        this.genCall(node);
        return;
      case 'vaarg':
        this.genVaArg(node);
        return;
      case 'neg':
        this.genFloatValue(node.lhs!);
        this.emit('  MOV R7, 2147483648');
        this.emit('  XOR R0, R7');
        return;
      default:
        this.genFloatBinary(node);
    }
  }

  private genDoubleExpr(node: Node): void {
    switch (node.kind) {
      case 'num':
        this.emit(`  MOV R0, ${node.value! >>> 0}`);
        this.emit(`  MOV R1, ${node.valueHi! >>> 0}`);
        return;
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
        this.genAddr(node.lhs!);
        this.pushTemp();
        this.genDoubleValue(node.rhs!);
        this.popTemp('R2');
        this.emit('  STORER R2, R0');
        this.emit('  MOV R7, 4');
        this.emit('  ADD R2, R7');
        this.emit('  STORER R2, R1');
        return;
      case 'cast':
        this.genDoubleValue(node.lhs!);
        return;
      case 'funcall':
        this.genCall(node);
        return;
      case 'vaarg':
        this.genVaArg(node);
        return;
      case 'neg':
        this.genDoubleValue(node.lhs!);
        this.emit('  MOV R7, 2147483648');
        this.emit('  XOR R1, R7');
        return;
      default:
        this.genDoubleBinary(node);
    }
  }

  private genFloatValue(node: Node): void {
    if (node.ty?.kind === 'float') {
      this.genExpr(node);
      return;
    }
    if (node.ty?.kind === 'double') {
      this.genDoubleValue(node);
      this.pushReg('R1');
      this.pushReg('R0');
      this.emit('  CALL __truncdfsf2');
      this.adjustCsp(-2 * 4);
      return;
    }
    this.genExpr(node);
    this.push();
    this.emit(
      `  CALL ${isUnsignedInteger(node.ty) || (node.ty && isPointerLike(node.ty)) ? '__floatunsisf' : '__floatsisf'}`,
    );
    this.adjustCsp(-1 * 4);
  }

  private genDoubleValue(node: Node): void {
    if (node.ty?.kind === 'double') {
      this.genExpr(node);
      return;
    }
    if (node.ty?.kind === 'float') {
      this.genFloatValue(node);
      this.push();
      this.emit('  CALL __extendsfdf2');
      this.adjustCsp(-1 * 4);
      return;
    }
    this.genExpr(node);
    this.push();
    this.emit(
      `  CALL ${isUnsignedInteger(node.ty) || (node.ty && isPointerLike(node.ty)) ? '__floatunsidf' : '__floatsidf'}`,
    );
    this.adjustCsp(-1 * 4);
  }

  private genFloatBinary(node: Node): void {
    this.genFloatValue(node.rhs!);
    this.push();
    this.genFloatValue(node.lhs!);
    this.push();
    this.emit(`  CALL ${this.floatBinaryHelper(node, 'sf')}`);
    this.adjustCsp(-2 * 4);
  }

  private genDoubleBinary(node: Node): void {
    this.genDoubleValue(node.rhs!);
    this.pushReg('R1');
    this.pushReg('R0');
    this.genDoubleValue(node.lhs!);
    this.pushReg('R1');
    this.pushReg('R0');
    this.emit(`  CALL ${this.floatBinaryHelper(node, 'df')}`);
    this.adjustCsp(-4 * 4);
  }

  private genFloatCompare(node: Node): void {
    const useDouble = node.lhs?.ty?.kind === 'double' || node.rhs?.ty?.kind === 'double';
    if (useDouble) {
      this.genDoubleValue(node.rhs!);
      this.pushReg('R1');
      this.pushReg('R0');
      this.genDoubleValue(node.lhs!);
      this.pushReg('R1');
      this.pushReg('R0');
      this.emit('  CALL __cmpdf2');
      this.adjustCsp(-4 * 4);
    } else {
      this.genFloatValue(node.rhs!);
      this.push();
      this.genFloatValue(node.lhs!);
      this.push();
      this.emit('  CALL __cmpsf2');
      this.adjustCsp(-2 * 4);
    }
    const yes = this.label('cmpf.true');
    const done = this.label('cmpf.done');
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

  // --- 64-bit (long long) codegen -----------------------------------------
  //
  // A 64-bit value lives in R0 (low word) : R1 (high word). Arithmetic,
  // shifts, and comparisons go through the `__i64_*`/`__u64_*` runtime helpers
  // (see runtime64.ts), which take the operand words as ordinary 32-bit
  // arguments and return the 64-bit result in R0:R1 (compares return an int).
  // Helper arguments are pushed right-to-left, like any other call.

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
      case 'vaarg':
        this.genVaArg(node);
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
    this.pushTemp(); // save destination address
    this.gen64Value(node.rhs!);
    this.popTemp('R2'); // R2 = address
    this.emit('  STORER R2, R0');
    this.emit('  MOV R7, 4');
    this.emit('  ADD R2, R7');
    this.emit('  STORER R2, R1');
  }

  // helper(a_lo, a_hi, b_lo, b_hi) -> R0:R1.
  private gen64Binary(node: Node, helper: string): void {
    this.gen64Value(node.rhs!);
    this.pushReg('R1'); // b_hi
    this.pushReg('R0'); // b_lo
    this.gen64Value(node.lhs!);
    this.pushReg('R1'); // a_hi
    this.pushReg('R0'); // a_lo
    this.emit(`  CALL ${helper}`);
    this.adjustCsp(-4 * 4);
  }

  // helper(v_lo, v_hi, amount) -> R0:R1
  private gen64Shift(node: Node, helper: string): void {
    this.genExpr(node.rhs!); // shift amount (32-bit)
    this.push();
    this.gen64Value(node.lhs!);
    this.pushReg('R1'); // v_hi
    this.pushReg('R0'); // v_lo
    this.emit(`  CALL ${helper}`);
    this.adjustCsp(-3 * 4);
  }

  // helper(v_lo, v_hi) -> R0:R1
  private gen64Unary(operand: Node, helper: string): void {
    this.gen64Value(operand);
    this.pushReg('R1'); // v_hi
    this.pushReg('R0'); // v_lo
    this.emit(`  CALL ${helper}`);
    this.adjustCsp(-2 * 4);
  }

  // helper(a_lo, a_hi, b_lo, b_hi) -> R0 = -1/0/1, turned into a 0/1 boolean.
  private gen64Compare(node: Node): void {
    const unsigned = isUnsignedInteger(node.lhs?.ty) || isUnsignedInteger(node.rhs?.ty);
    this.gen64Value(node.rhs!);
    this.pushReg('R1'); // b_hi
    this.pushReg('R0'); // b_lo
    this.gen64Value(node.lhs!);
    this.pushReg('R1'); // a_hi
    this.pushReg('R0'); // a_lo
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
    // Arguments are pushed right-to-left, matching the bootstrap compiler's ABI
    // (chibicc objects link against bootstrap-compiled crt0/libc, so the two
    // must agree). A `long long` argument occupies two slots, low word first.
    const args = node.args ?? [];
    let words = 0;
    for (let i = args.length - 1; i >= 0; i--) {
      words += this.pushCallArg(args[i]!);
    }
    if (isAggregate(node.funcReturn)) {
      if (!node.variable) throw new CodegenError('aggregate call without a return buffer');
      this.genAddr({ kind: 'var', line: node.line, variable: node.variable, ty: node.variable.ty });
      this.push();
      words += 1;
    }
    if (node.funcExpr) {
      this.genExpr(node.funcExpr);
      this.emit('  CALLR R0');
    } else {
      this.emit(`  CALL ${node.funcName}`);
    }
    if (words > 0) this.adjustCsp(-words * 4);
    if (isAggregate(node.funcReturn) && node.variable) {
      this.genAddr({ kind: 'var', line: node.line, variable: node.variable, ty: node.variable.ty });
    }
  }

  private pushCallArg(arg: Node): number {
    if (arg.ty?.kind === 'double') {
      this.genDoubleValue(arg); // R0=low, R1=high
      this.pushReg('R0'); // low word (lower address)
      this.pushReg('R1'); // high word (higher address)
      return 2;
    }
    if (is64(arg.ty)) {
      this.gen64Value(arg); // R0=low, R1=high
      this.pushReg('R0'); // low word (lower address)
      this.pushReg('R1'); // high word (higher address)
      return 2;
    }
    if (isAggregate(arg.ty)) {
      this.genAddr(arg);
      this.emit('  LOAD R1, __csp');
      this.copyBytes(Math.max(1, arg.ty?.size ?? 1));
      const bytes = this.slotSize(arg.ty);
      this.adjustCsp(bytes);
      return bytes / 4;
    }
    this.genExpr(arg);
    this.push();
    return 1;
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
      case '__iret':
        this.emit('  IRET');
        this.emit('  MOV R0, 0');
        return;
      case '__lidt':
        intoRegs(['R1']);
        this.emit('  LIDT R1');
        this.emit('  MOV R0, 0');
        return;
      case '__lksp':
        intoRegs(['R1']);
        this.emit('  LKSP R1');
        this.emit('  MOV R0, 0');
        return;
      case '__stmr':
        intoRegs(['R1']);
        this.emit('  STMR R1');
        this.emit('  MOV R0, 0');
        return;
      case '__lptbr':
        intoRegs(['R1']);
        this.emit('  LPTBR R1');
        this.emit('  MOV R0, 0');
        return;
      case '__pgon':
        this.emit('  PGON');
        this.emit('  MOV R0, 0');
        return;
      case '__pgoff':
        this.emit('  PGOFF');
        this.emit('  MOV R0, 0');
        return;
      case '__rdpfla':
        this.emit('  RDPFLA R0');
        return;
      case '__rderr':
        this.emit('  RDERR R0');
        return;
      case '__ei':
        this.emit('  EI');
        this.emit('  MOV R0, 0');
        return;
      case '__di':
        this.emit('  DI');
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
