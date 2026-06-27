// Recursive-descent parser + semantic analysis for the chibicc-derived custom32
// frontend.
//
// Ported from chibicc's `parse.c`, scoped to the Phase 31 backend slice:
// `int`/`char`/`void` (with `short`/`long`/`unsigned` accepted), pointers and
// arrays, function definitions and prototypes, global and local variables,
// `if`/`while`/`for`/`return`/`break`/`continue`/blocks, and the full C
// expression grammar down to assignment, the binary operators, unary `&`/`*`,
// calls, indexing, and string/number literals. Like upstream, pointer
// arithmetic scaling and `a[i]` desugaring happen here in the parser (see
// `newAdd`/`newSub`), so the backend never has to think about element sizes.
//
// typedef/enum/struct/union, initializer lists, function pointers, and the rest
// arrive with Phase 32.

import type { Token } from './tokenize.ts';
import {
  addType,
  arrayOf,
  elementType,
  funcType,
  isInteger,
  isPointerLike,
  pointerTo,
  type Type,
  tyChar,
  tyInt,
  tyLong,
  tyShort,
  tyVoid,
} from './type.ts';

export class ParseError extends Error {
  constructor(message: string, line: number) {
    super(`parse error (line ${line}): ${message}`);
  }
}

export type NodeKind =
  | 'num'
  | 'var'
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'mod'
  | 'neg'
  | 'not'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'bitand'
  | 'bitor'
  | 'bitxor'
  | 'shl'
  | 'shr'
  | 'logand'
  | 'logor'
  | 'assign'
  | 'addr'
  | 'deref'
  | 'funcall'
  | 'return'
  | 'if'
  | 'for'
  | 'block'
  | 'exprstmt'
  | 'break'
  | 'continue';

export interface Node {
  kind: NodeKind;
  line: number;
  ty?: Type;
  // Binary / unary operands.
  lhs?: Node;
  rhs?: Node;
  // Control flow.
  cond?: Node;
  // `thenStmt`/`els`: chibicc's `then`/`els`. (`then` is avoided because it makes
  // the node object look thenable.) Also the loop body for `for`/`while` nodes.
  thenStmt?: Node;
  els?: Node;
  init?: Node;
  inc?: Node;
  body?: Node[];
  // Leaves.
  value?: number; // num
  variable?: Obj; // var
  // Calls.
  funcName?: string;
  builtin?: string; // intrinsic name (e.g. __syscall) when set
  args?: Node[];
  funcReturn?: Type;
}

// An Obj is a named object: a global variable, a string literal, a local
// variable, a parameter, or a function. Mirrors chibicc's single Obj type.
export interface Obj {
  name: string;
  ty: Type;
  isLocal: boolean;
  isFunction: boolean;
  isStatic: boolean;
  // A pure `extern` declaration: storage/definition lives in another unit.
  isExtern?: boolean;
  // Storage offset from the frame base R6 (locals positive, params negative).
  offset?: number;
  isParam?: boolean;
  // Global variable storage.
  initData?: Uint8Array; // initialized bytes, or undefined for bss
  isString?: boolean; // anonymous string-literal storage
  // Function.
  hasBody?: boolean;
  params?: Obj[];
  locals?: Obj[];
  bodyNode?: Node;
  stackSize?: number;
}

export interface Program {
  // Globals, string literals, and functions in definition order.
  objects: Obj[];
}

interface DeclSpec {
  ty: Type;
  isStatic: boolean;
  isExtern: boolean;
}

function align(n: number, a: number): number {
  return Math.floor((n + a - 1) / a) * a;
}

class Parser {
  private pos = 0;
  private readonly globals = new Map<string, Obj>();
  private readonly objects: Obj[] = [];
  private scopes: Map<string, Obj>[] = [];
  private currentFn: Obj | null = null;
  private strCount = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): Program {
    while (!this.isEof()) this.topLevel();
    return { objects: this.objects };
  }

  // --- token helpers -------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private isEof(): boolean {
    return this.peek().kind === 'eof';
  }

  private equal(text: string): boolean {
    const t = this.peek();
    return (t.kind === 'punct' || t.kind === 'keyword') && t.text === text;
  }

  private consume(text: string): boolean {
    if (this.equal(text)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(text: string): void {
    if (!this.consume(text)) {
      throw new ParseError(`expected '${text}' but got '${this.peek().text}'`, this.peek().line);
    }
  }

  private expectIdent(): string {
    const t = this.peek();
    if (t.kind !== 'ident') throw new ParseError(`expected an identifier`, t.line);
    this.pos++;
    return t.text;
  }

  private error(message: string): never {
    throw new ParseError(message, this.peek().line);
  }

  // --- declarations --------------------------------------------------------

  private isTypeName(): boolean {
    const t = this.peek();
    if (t.kind !== 'keyword') return false;
    return [
      'void',
      'char',
      'short',
      'int',
      'long',
      'unsigned',
      'signed',
      'static',
      'extern',
    ].includes(t.text);
  }

  // declspec = (storage-class | type-keyword)*
  private declspec(): DeclSpec {
    let isStatic = false;
    let isExtern = false;
    let hasChar = false;
    let hasShort = false;
    let hasLong = false;
    let hasInt = false;
    let hasVoid = false;
    let count = 0;

    while (this.peek().kind === 'keyword') {
      const word = this.peek().text;
      if (word === 'static') {
        isStatic = true;
        this.pos++;
        continue;
      }
      if (word === 'extern') {
        isExtern = true;
        this.pos++;
        continue;
      }
      if (word === 'unsigned' || word === 'signed') {
        // Sign is accepted but not yet distinguished in the slice.
        this.pos++;
        count++;
        continue;
      }
      if (word === 'void') {
        hasVoid = true;
        this.pos++;
        count++;
        continue;
      }
      if (word === 'char') {
        hasChar = true;
        this.pos++;
        count++;
        continue;
      }
      if (word === 'short') {
        hasShort = true;
        this.pos++;
        count++;
        continue;
      }
      if (word === 'long') {
        hasLong = true;
        this.pos++;
        count++;
        continue;
      }
      if (word === 'int') {
        hasInt = true;
        this.pos++;
        count++;
        continue;
      }
      break;
    }

    if (count === 0 && !isStatic && !isExtern) this.error('expected a type specifier');

    let ty: Type;
    if (hasVoid) ty = tyVoid;
    else if (hasChar) ty = tyChar;
    else if (hasShort) ty = tyShort;
    else if (hasLong) ty = tyLong;
    else ty = tyInt; // plain int, or `unsigned`/`signed` with no other keyword
    void hasInt;
    return { ty, isStatic, isExtern };
  }

  // declarator = "*"* ident type-suffix
  private declarator(base: Type): { ty: Type; name: string } {
    let ty = base;
    while (this.consume('*')) ty = pointerTo(ty);
    const name = this.expectIdent();
    ty = this.typeSuffix(ty);
    return { ty, name };
  }

  // type-suffix = "(" func-params ")" | "[" num "]" type-suffix | ε
  private typeSuffix(base: Type): Type {
    if (this.equal('(')) return this.funcParams(base);
    if (this.consume('[')) {
      const len = this.peek().value;
      if (this.peek().kind !== 'num') this.error('expected an array length');
      this.pos++;
      this.expect(']');
      return arrayOf(this.typeSuffix(base), len);
    }
    return base;
  }

  // func-params = "(" ("void" | param ("," param)*)? ")"
  // Returns a function type; parameter Objs are materialized later in funcDef.
  private funcParams(returnType: Type): Type {
    this.expect('(');
    const params: Type[] = [];
    this.pendingParams = [];
    if (this.equal('void') && this.peek(1).text === ')') {
      this.pos++;
    } else if (!this.equal(')')) {
      do {
        const spec = this.declspec();
        const { ty, name } = this.declarator(spec.ty);
        // Arrays and functions decay to pointers in a parameter list.
        const pty = ty.kind === 'array' ? pointerTo(elementType(ty)) : ty;
        params.push(pty);
        this.pendingParams.push({ ty: pty, name });
      } while (this.consume(','));
    }
    this.expect(')');
    return funcType(returnType, params);
  }

  private pendingParams: { ty: Type; name: string }[] = [];

  // top-level = function-definition | global-declaration
  private topLevel(): void {
    const spec = this.declspec();
    const { ty, name } = this.declarator(spec.ty);

    if (ty.kind === 'func') {
      this.functionOrPrototype(name, ty, spec, [...this.pendingParams]);
      return;
    }

    // Global variable declaration list.
    this.globalVariable(name, ty, spec);
    while (this.consume(',')) {
      const next = this.declarator(spec.ty);
      this.globalVariable(next.name, next.ty, spec);
    }
    this.expect(';');
  }

  private functionOrPrototype(
    name: string,
    ty: Type,
    spec: DeclSpec,
    params: { ty: Type; name: string }[],
  ): void {
    const existing = this.globals.get(name);
    const fn: Obj = existing ?? {
      name,
      ty,
      isLocal: false,
      isFunction: true,
      isStatic: spec.isStatic,
      params: [],
      locals: [],
    };
    if (!existing) {
      this.globals.set(name, fn);
      this.objects.push(fn);
    }

    if (this.consume(';')) return; // prototype only

    // Function definition: build parameter and local scope, parse the body.
    this.currentFn = fn;
    fn.hasBody = true;
    fn.params = [];
    fn.locals = [];
    this.scopes = [new Map()];
    for (const p of params) {
      const obj: Obj = {
        name: p.name,
        ty: p.ty,
        isLocal: true,
        isFunction: false,
        isStatic: false,
        isParam: true,
      };
      fn.params.push(obj);
      this.currentScope().set(p.name, obj);
    }
    this.expect('{');
    fn.bodyNode = this.compoundStmt();
    this.assignOffsets(fn);
    this.currentFn = null;
  }

  private globalVariable(name: string, ty: Type, spec: DeclSpec): void {
    const obj: Obj = {
      name,
      ty,
      isLocal: false,
      isFunction: false,
      isStatic: spec.isStatic,
      isExtern: spec.isExtern,
    };
    // `int x = 5;` defines initialized storage. `extern int x;` only records the
    // type for resolution and emits no storage; a plain `int x;` is a tentative
    // definition that lands in BSS.
    if (!spec.isExtern && this.consume('=')) {
      obj.initData = this.globalInitializer(ty);
    }
    this.globals.set(name, obj);
    this.objects.push(obj);
  }

  // Constant initializer for a scalar global (the slice supports integer
  // constants; richer initializers arrive with Phase 32).
  private globalInitializer(ty: Type): Uint8Array {
    const t = this.peek();
    if (t.kind !== 'num') {
      this.error('global initializers must be integer constants in this slice');
    }
    this.pos++;
    const size = Math.max(1, ty.size);
    const bytes = new Uint8Array(size);
    let v = t.value >>> 0;
    for (let i = 0; i < Math.min(4, size); i++) {
      bytes[i] = v & 0xff;
      v >>>= 8;
    }
    return bytes;
  }

  // --- statements ----------------------------------------------------------

  private compoundStmt(): Node {
    const body: Node[] = [];
    this.scopes.push(new Map());
    while (!this.consume('}')) {
      if (this.isEof()) this.error("expected '}'");
      if (this.isTypeName()) body.push(this.declaration());
      else body.push(this.stmt());
    }
    this.scopes.pop();
    return { kind: 'block', line: this.peek().line, body };
  }

  // declaration = declspec (declarator ("=" expr)? ("," ...)*)? ";"
  private declaration(): Node {
    const spec = this.declspec();
    const body: Node[] = [];
    let first = true;
    while (!this.consume(';')) {
      if (!first) this.expect(',');
      first = false;
      const { ty, name } = this.declarator(spec.ty);
      if (ty.kind === 'void') this.error(`variable '${name}' declared void`);
      const obj = this.newLocal(name, ty);
      if (this.consume('=')) {
        const lhs: Node = { kind: 'var', line: this.peek().line, variable: obj };
        const rhs = this.assign();
        const assignNode: Node = { kind: 'assign', line: lhs.line, lhs, rhs };
        body.push({ kind: 'exprstmt', line: lhs.line, lhs: assignNode });
      }
    }
    return { kind: 'block', line: this.peek().line, body };
  }

  private stmt(): Node {
    const line = this.peek().line;

    if (this.consume('return')) {
      if (this.consume(';')) return { kind: 'return', line };
      const expr = this.expr();
      this.expect(';');
      return { kind: 'return', line, lhs: expr };
    }

    if (this.consume('if')) {
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      const thenStmt = this.stmt();
      const els = this.consume('else') ? this.stmt() : undefined;
      return { kind: 'if', line, cond, thenStmt, els };
    }

    if (this.consume('while')) {
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      const bodyStmt = this.stmt();
      // `while` is a `for` with only a condition (chibicc's shape).
      return { kind: 'for', line, cond, thenStmt: bodyStmt };
    }

    if (this.consume('for')) {
      this.expect('(');
      this.scopes.push(new Map());
      let init: Node | undefined;
      if (!this.consume(';')) {
        if (this.isTypeName()) init = this.declaration();
        else {
          const e = this.expr();
          this.expect(';');
          init = { kind: 'exprstmt', line, lhs: e };
        }
      }
      let cond: Node | undefined;
      if (!this.equal(';')) cond = this.expr();
      this.expect(';');
      let inc: Node | undefined;
      if (!this.equal(')')) inc = this.expr();
      this.expect(')');
      const bodyStmt = this.stmt();
      this.scopes.pop();
      return { kind: 'for', line, init, cond, thenStmt: bodyStmt, inc };
    }

    if (this.consume('break')) {
      this.expect(';');
      return { kind: 'break', line };
    }
    if (this.consume('continue')) {
      this.expect(';');
      return { kind: 'continue', line };
    }

    if (this.equal('{')) {
      this.pos++;
      return this.compoundStmt();
    }

    // expression statement (or empty statement)
    if (this.consume(';')) return { kind: 'block', line, body: [] };
    const e = this.expr();
    this.expect(';');
    return { kind: 'exprstmt', line, lhs: e };
  }

  // --- expressions ---------------------------------------------------------

  private expr(): Node {
    return this.assign();
  }

  private assign(): Node {
    const node = this.logor();
    if (this.equal('=')) {
      const line = this.peek().line;
      this.pos++;
      return { kind: 'assign', line, lhs: node, rhs: this.assign() };
    }
    return node;
  }

  private logor(): Node {
    let node = this.logand();
    while (this.equal('||')) {
      const line = this.peek().line;
      this.pos++;
      node = { kind: 'logor', line, lhs: node, rhs: this.logand() };
    }
    return node;
  }

  private logand(): Node {
    let node = this.bitor();
    while (this.equal('&&')) {
      const line = this.peek().line;
      this.pos++;
      node = { kind: 'logand', line, lhs: node, rhs: this.bitor() };
    }
    return node;
  }

  private bitor(): Node {
    let node = this.bitxor();
    while (this.equal('|')) {
      const line = this.peek().line;
      this.pos++;
      node = { kind: 'bitor', line, lhs: node, rhs: this.bitxor() };
    }
    return node;
  }

  private bitxor(): Node {
    let node = this.bitand();
    while (this.equal('^')) {
      const line = this.peek().line;
      this.pos++;
      node = { kind: 'bitxor', line, lhs: node, rhs: this.bitand() };
    }
    return node;
  }

  private bitand(): Node {
    let node = this.equality();
    while (this.equal('&')) {
      const line = this.peek().line;
      this.pos++;
      node = { kind: 'bitand', line, lhs: node, rhs: this.equality() };
    }
    return node;
  }

  private equality(): Node {
    let node = this.relational();
    for (;;) {
      const line = this.peek().line;
      if (this.consume('==')) node = { kind: 'eq', line, lhs: node, rhs: this.relational() };
      else if (this.consume('!=')) node = { kind: 'ne', line, lhs: node, rhs: this.relational() };
      else return node;
    }
  }

  private relational(): Node {
    let node = this.shift();
    for (;;) {
      const line = this.peek().line;
      if (this.consume('<')) node = { kind: 'lt', line, lhs: node, rhs: this.shift() };
      else if (this.consume('<=')) node = { kind: 'le', line, lhs: node, rhs: this.shift() };
      // `a > b` and `a >= b` reuse lt/le with the operands swapped.
      else if (this.consume('>')) node = { kind: 'lt', line, lhs: this.shift(), rhs: node };
      else if (this.consume('>=')) node = { kind: 'le', line, lhs: this.shift(), rhs: node };
      else return node;
    }
  }

  private shift(): Node {
    let node = this.add();
    for (;;) {
      const line = this.peek().line;
      if (this.consume('<<')) node = { kind: 'shl', line, lhs: node, rhs: this.add() };
      else if (this.consume('>>')) node = { kind: 'shr', line, lhs: node, rhs: this.add() };
      else return node;
    }
  }

  private add(): Node {
    let node = this.mul();
    for (;;) {
      const line = this.peek().line;
      if (this.consume('+')) node = this.newAdd(node, this.mul(), line);
      else if (this.consume('-')) node = this.newSub(node, this.mul(), line);
      else return node;
    }
  }

  private mul(): Node {
    let node = this.unary();
    for (;;) {
      const line = this.peek().line;
      if (this.consume('*')) node = { kind: 'mul', line, lhs: node, rhs: this.unary() };
      else if (this.consume('/')) node = { kind: 'div', line, lhs: node, rhs: this.unary() };
      else if (this.consume('%')) node = { kind: 'mod', line, lhs: node, rhs: this.unary() };
      else return node;
    }
  }

  private unary(): Node {
    const line = this.peek().line;
    if (this.consume('+')) return this.unary();
    if (this.consume('-')) return { kind: 'neg', line, lhs: this.unary() };
    if (this.consume('!')) return { kind: 'not', line, lhs: this.unary() };
    if (this.consume('*')) return { kind: 'deref', line, lhs: this.unary() };
    if (this.consume('&')) return { kind: 'addr', line, lhs: this.unary() };
    if (this.consume('~')) {
      // ~x == x ^ -1, reusing the bitxor path.
      const operand = this.unary();
      return { kind: 'bitxor', line, lhs: operand, rhs: { kind: 'num', line, value: 0xffffffff } };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let node = this.primary();
    for (;;) {
      const line = this.peek().line;
      if (this.consume('[')) {
        // a[i] === *(a + i)
        const index = this.expr();
        this.expect(']');
        node = { kind: 'deref', line, lhs: this.newAdd(node, index, line) };
        continue;
      }
      return node;
    }
  }

  private primary(): Node {
    const t = this.peek();

    if (this.consume('(')) {
      const node = this.expr();
      this.expect(')');
      return node;
    }

    if (this.equal('sizeof')) {
      this.pos++;
      const operand = this.unary();
      addType(operand);
      return { kind: 'num', line: t.line, value: operand.ty?.size ?? 4 };
    }

    if (t.kind === 'num') {
      this.pos++;
      return { kind: 'num', line: t.line, value: t.value };
    }

    if (t.kind === 'str') {
      this.pos++;
      const obj = this.newStringLiteral(t.str);
      return { kind: 'var', line: t.line, variable: obj };
    }

    if (t.kind === 'ident') {
      this.pos++;
      if (this.equal('(')) return this.funcall(t.text, t.line);
      const obj = this.resolve(t.text);
      return { kind: 'var', line: t.line, variable: obj };
    }

    this.error(`unexpected token '${t.text}'`);
  }

  private funcall(name: string, line: number): Node {
    this.expect('(');
    const args: Node[] = [];
    if (!this.equal(')')) {
      do {
        args.push(this.assign());
      } while (this.consume(','));
    }
    this.expect(')');

    // `__`-prefixed names are target intrinsics handled by the backend, not real
    // calls. They need no declaration.
    if (name.startsWith('__')) {
      return { kind: 'funcall', line, builtin: name, args, funcReturn: tyInt };
    }

    const fn = this.globals.get(name);
    const funcReturn = fn?.isFunction ? (fn.ty.returnType ?? tyInt) : tyInt;
    return { kind: 'funcall', line, funcName: name, args, funcReturn };
  }

  // --- pointer-aware add/sub (chibicc new_add / new_sub) --------------------

  private newAdd(lhs: Node, rhs: Node, line: number): Node {
    addType(lhs);
    addType(rhs);
    const lt = lhs.ty!;
    const rt = rhs.ty!;
    if (isInteger(lt) && isInteger(rt)) return { kind: 'add', line, lhs, rhs };
    if (isPointerLike(lt) && isPointerLike(rt)) this.error('invalid pointer + pointer');
    // Canonicalize to `pointer + integer`.
    let p = lhs;
    let n = rhs;
    let pt = lt;
    if (isInteger(lt) && isPointerLike(rt)) {
      p = rhs;
      n = lhs;
      pt = rt;
    }
    const scale = Math.max(1, elementType(pt).size);
    const scaled: Node =
      scale === 1 ? n : { kind: 'mul', line, lhs: n, rhs: { kind: 'num', line, value: scale } };
    return { kind: 'add', line, lhs: p, rhs: scaled };
  }

  private newSub(lhs: Node, rhs: Node, line: number): Node {
    addType(lhs);
    addType(rhs);
    const lt = lhs.ty!;
    const rt = rhs.ty!;
    if (isInteger(lt) && isInteger(rt)) return { kind: 'sub', line, lhs, rhs };
    if (isPointerLike(lt) && isInteger(rt)) {
      // ptr - integer: scale the integer side by the element size.
      const scale = Math.max(1, elementType(lt).size);
      const scaled: Node =
        scale === 1
          ? rhs
          : { kind: 'mul', line, lhs: rhs, rhs: { kind: 'num', line, value: scale } };
      const node: Node = { kind: 'sub', line, lhs, rhs: scaled };
      node.ty = lt;
      return node;
    }
    if (isPointerLike(lt) && isPointerLike(rt)) {
      // ptr - ptr: byte distance divided by the element size.
      const scale = Math.max(1, elementType(lt).size);
      const diff: Node = { kind: 'sub', line, lhs, rhs };
      diff.ty = tyInt;
      if (scale === 1) return diff;
      return { kind: 'div', line, lhs: diff, rhs: { kind: 'num', line, value: scale } };
    }
    this.error('invalid operands to -');
  }

  // --- scope / symbol management -------------------------------------------

  private currentScope(): Map<string, Obj> {
    return this.scopes[this.scopes.length - 1]!;
  }

  private newLocal(name: string, ty: Type): Obj {
    const obj: Obj = { name, ty, isLocal: true, isFunction: false, isStatic: false };
    this.currentFn?.locals?.push(obj);
    this.currentScope().set(name, obj);
    return obj;
  }

  private newStringLiteral(bytes: Uint8Array): Obj {
    const obj: Obj = {
      name: `.L.str.${this.strCount++}`,
      ty: arrayOf(tyChar, bytes.length),
      isLocal: false,
      isFunction: false,
      isStatic: true,
      initData: bytes,
      isString: true,
    };
    this.objects.push(obj);
    return obj;
  }

  private resolve(name: string): Obj {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i]!.get(name);
      if (found) return found;
    }
    const global = this.globals.get(name);
    if (global) return global;
    this.error(`undefined variable '${name}'`);
  }

  // Assign frame offsets once the whole function is parsed: parameters at
  // negative offsets (the caller pushed them below the frame base), locals at
  // positive offsets growing upward.
  private assignOffsets(fn: Obj): void {
    const params = fn.params ?? [];
    const nparams = params.length;
    params.forEach((p, i) => {
      p.offset = -((nparams - i) * 4);
    });
    let cursor = 0;
    for (const local of fn.locals ?? []) {
      const a = Math.min(4, local.ty.align);
      cursor = align(cursor, a);
      local.offset = cursor;
      cursor += align(Math.max(1, local.ty.size), 4);
    }
    fn.stackSize = align(cursor, 4);
  }
}

export function parse(tokens: Token[]): Program {
  return new Parser(tokens).parse();
}
