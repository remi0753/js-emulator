import { SYS } from '../abi.ts';
import { SYSCALL_INT } from '../isa.ts';
import { PORT } from '../vm/custom32/platform.ts';

export interface CompileOptions {
  start?: 'user' | 'kernel' | 'none';
  entry?: string;
  includeRuntime?: boolean;
  cStackSize?: number;
  // Namespaces this object's private (compiler-generated) labels so several
  // objects can be linked together without their local labels colliding.
  // Defaults to a process-unique id; public symbols (functions, globals,
  // runtime helpers, `_start`) are never namespaced so cross-object references
  // still resolve.
  moduleId?: string | number;
}

export interface CompiledObject {
  name: string;
  text: string;
  data: DataSymbol[];
  bss: BssSymbol[];
  globals: Map<string, CType>;
  functions: Map<string, FunctionSig>;
  sourceMap: Map<string, SourceLocation>;
}

export interface DataSymbol {
  name: string;
  bytes: Uint8Array;
  size: number;
  // Relocations to apply once symbol addresses are known: write the linked
  // address of `target` into the 4 bytes at `offset` within `bytes`.
  relocs?: DataReloc[];
}

export interface DataReloc {
  offset: number;
  target: string;
}

export interface BssSymbol {
  name: string;
  size: number;
}

export interface SourceLocation {
  line: number;
  column: number;
}

type TokenKind = 'id' | 'num' | 'str' | 'char' | 'punc' | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  value?: number | string;
  line: number;
  column: number;
}

export class CompileError extends Error {
  readonly loc?: SourceLocation;

  constructor(message: string, loc?: SourceLocation) {
    super(loc ? `${message} (${loc.line}:${loc.column})` : message);
    this.loc = loc;
  }
}

const MULTI_PUNC = ['==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '->'];

const encoder = new TextEncoder();

export type CType =
  | { kind: 'void' }
  | { kind: 'int' }
  | { kind: 'char' }
  | { kind: 'ptr'; to: CType }
  | { kind: 'array'; of: CType; len: number }
  | { kind: 'struct'; name: string; fields: Field[]; size: number }
  | { kind: 'funcptr'; returnType: CType; params: Param[] };

export interface Field {
  name: string;
  type: CType;
  offset: number;
}

export interface FunctionSig {
  name: string;
  returnType: CType;
  params: Param[];
}

export interface Param {
  name: string;
  type: CType;
}

interface Program {
  structs: Map<string, CType>;
  globals: GlobalDecl[];
  prototypes: FunctionSig[];
  functions: FuncDecl[];
}

interface GlobalDecl {
  kind: 'global';
  name: string;
  type: CType;
  init: Initializer | null;
  // An `extern` declaration registers the symbol's type for this translation
  // unit but emits no storage; the linker resolves the reference to the object
  // that actually defines it.
  extern: boolean;
}

interface FuncDecl {
  kind: 'func';
  name: string;
  returnType: CType;
  params: Param[];
  body: Stmt;
  loc: SourceLocation;
}

type Initializer =
  | { kind: 'expr'; expr: Expr }
  | { kind: 'list'; items: Initializer[] }
  | { kind: 'string'; value: string };

type Stmt =
  | { kind: 'block'; stmts: Stmt[] }
  | { kind: 'decl'; decls: LocalDecl[] }
  | { kind: 'expr'; expr: Expr | null }
  | { kind: 'return'; expr: Expr | null }
  | { kind: 'if'; cond: Expr; then: Stmt; otherwise: Stmt | null }
  | { kind: 'while'; cond: Expr; body: Stmt }
  | { kind: 'for'; init: Stmt | Expr | null; cond: Expr | null; post: Expr | null; body: Stmt }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'asm'; source: string };

interface LocalDecl {
  name: string;
  type: CType;
  init: Expr | null;
  offset?: number;
}

type Expr =
  | { kind: 'num'; value: number; type?: CType }
  | { kind: 'str'; value: string; label?: string; type?: CType }
  | { kind: 'var'; name: string; type?: CType }
  | { kind: 'assign'; left: Expr; right: Expr; type?: CType }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; type?: CType }
  | { kind: 'unary'; op: string; expr: Expr; type?: CType }
  | { kind: 'call'; callee: string; args: Expr[]; type?: CType }
  | { kind: 'callptr'; target: Expr; args: Expr[]; type?: CType }
  | { kind: 'index'; base: Expr; index: Expr; type?: CType }
  | { kind: 'member'; base: Expr; name: string; deref: boolean; type?: CType }
  | { kind: 'sizeof'; typeName: CType; type?: CType };

function loc(t: Token): SourceLocation {
  return { line: t.line, column: t.column };
}

class Lexer {
  private tokens: Token[] = [];
  private i = 0;
  private line = 1;
  private column = 1;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  tokenize(): Token[] {
    while (!this.eof()) {
      const c = this.peekChar();
      if (/\s/.test(c)) {
        this.advance();
        continue;
      }
      if (c === '/' && this.peekChar(1) === '/') {
        while (!this.eof() && this.peekChar() !== '\n') this.advance();
        continue;
      }
      if (c === '/' && this.peekChar(1) === '*') {
        this.advance();
        this.advance();
        while (!this.eof() && !(this.peekChar() === '*' && this.peekChar(1) === '/')) {
          this.advance();
        }
        if (this.eof()) this.fail('unterminated block comment');
        this.advance();
        this.advance();
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        this.readIdent();
        continue;
      }
      if (/\d/.test(c)) {
        this.readNumber();
        continue;
      }
      if (c === '"') {
        this.readString();
        continue;
      }
      if (c === "'") {
        this.readChar();
        continue;
      }
      this.readPunc();
    }
    this.tokens.push({ kind: 'eof', text: '<eof>', line: this.line, column: this.column });
    return this.tokens;
  }

  private eof(): boolean {
    return this.i >= this.source.length;
  }

  private peekChar(n = 0): string {
    return this.source[this.i + n] ?? '\0';
  }

  private advance(): string {
    const c = this.source[this.i++] ?? '\0';
    if (c === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return c;
  }

  private readIdent(): void {
    const line = this.line;
    const column = this.column;
    let s = '';
    while (!this.eof() && /[A-Za-z0-9_]/.test(this.peekChar())) s += this.advance();
    this.tokens.push({ kind: 'id', text: s, line, column });
  }

  private readNumber(): void {
    const line = this.line;
    const column = this.column;
    let s = '';
    if (this.peekChar() === '0' && /[xX]/.test(this.peekChar(1))) {
      s += this.advance();
      s += this.advance();
      while (!this.eof() && /[0-9a-fA-F]/.test(this.peekChar())) s += this.advance();
    } else {
      while (!this.eof() && /\d/.test(this.peekChar())) s += this.advance();
    }
    this.tokens.push({ kind: 'num', text: s, value: Number(s) >>> 0, line, column });
  }

  private readString(): void {
    const line = this.line;
    const column = this.column;
    this.advance();
    let s = '';
    while (!this.eof() && this.peekChar() !== '"') s += this.readEscaped();
    if (this.eof()) this.fail('unterminated string literal');
    this.advance();
    this.tokens.push({ kind: 'str', text: s, value: s, line, column });
  }

  private readChar(): void {
    const line = this.line;
    const column = this.column;
    this.advance();
    const c = this.readEscaped();
    if (this.peekChar() !== "'") this.fail('unterminated char literal');
    this.advance();
    this.tokens.push({ kind: 'char', text: c, value: c.charCodeAt(0) >>> 0, line, column });
  }

  private readEscaped(): string {
    const c = this.advance();
    if (c !== '\\') return c;
    const e = this.advance();
    switch (e) {
      case '0':
        return '\0';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return e;
    }
  }

  private readPunc(): void {
    const line = this.line;
    const column = this.column;
    for (const p of MULTI_PUNC) {
      if (this.source.slice(this.i, this.i + p.length) === p) {
        for (let n = 0; n < p.length; n++) this.advance();
        this.tokens.push({ kind: 'punc', text: p, line, column });
        return;
      }
    }
    const p = this.advance();
    this.tokens.push({ kind: 'punc', text: p, line, column });
  }

  private fail(message: string): never {
    throw new CompileError(message, { line: this.line, column: this.column });
  }
}

class Parser {
  private i = 0;
  readonly structs = new Map<string, CType>();
  private readonly typedefs = new Map<string, CType>();
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseProgram(): Program {
    const globals: GlobalDecl[] = [];
    const prototypes: FunctionSig[] = [];
    const functions: FuncDecl[] = [];
    while (!this.at('eof')) {
      if (this.peekText() === 'typedef') {
        this.parseTypedef();
        continue;
      }
      // A bare `struct name { ... };` is a type definition, not a declaration.
      // Look ahead without consuming so `struct name var;` still parses as a
      // struct-typed declaration below.
      if (this.peekText() === 'struct' && this.peekText(2) === '{') {
        this.parseStructDefinition();
        continue;
      }
      const isExtern = this.matchText('extern');
      const base = this.parseType();
      const first = this.parseDeclarator(base);
      if (this.matchText('(')) {
        const params = this.parseParams();
        if (this.matchText(';')) {
          prototypes.push({ name: first.name, returnType: first.type, params });
          continue;
        }
        const body = this.parseStmt();
        functions.push({
          kind: 'func',
          name: first.name,
          returnType: first.type,
          params,
          body,
          loc: loc(this.tokens[Math.max(0, this.i - 1)]!),
        });
        continue;
      }
      // `extern` declarations cannot carry an initializer (they only name a
      // symbol defined elsewhere).
      const decls = this.parseDeclTail(first, !isExtern);
      for (const d of decls) globals.push({ kind: 'global', extern: isExtern, ...d });
    }
    return { structs: this.structs, globals, prototypes, functions };
  }

  // Supports a function-pointer typedef -- `typedef RET (*NAME)(params);` -- and
  // a simple alias -- `typedef BASE NAME;` (with optional `*`). Function-pointer
  // typedefs let a dispatch table be declared in standard C that both this
  // compiler and an external C parser (editor IntelliSense) accept.
  private parseTypedef(): void {
    this.expectText('typedef');
    const base = this.parseType();
    if (this.matchText('(')) {
      this.expectText('*');
      const name = this.expect('id').text;
      this.expectText(')');
      this.expectText('(');
      const params = this.parseParams();
      this.expectText(';');
      this.typedefs.set(name, { kind: 'funcptr', returnType: base, params });
      return;
    }
    const d = this.parseDeclarator(base);
    this.expectText(';');
    this.typedefs.set(d.name, d.type);
  }

  private parseStructDefinition(): CType {
    this.expectText('struct');
    const name = this.expect('id').text;
    this.expectText('{');
    const rawFields: { name: string; type: CType }[] = [];
    while (!this.matchText('}')) {
      const base = this.parseType();
      const fields = this.parseDeclTail(this.parseDeclarator(base), false);
      for (const f of fields) rawFields.push({ name: f.name, type: f.type });
    }
    this.expectText(';');
    let offset = 0;
    const fields: Field[] = [];
    for (const f of rawFields) {
      offset = align(offset, Math.min(typeAlign(f.type), 4));
      fields.push({ name: f.name, type: f.type, offset });
      offset += typeSize(f.type);
    }
    const ty: CType = { kind: 'struct', name, fields, size: align(offset, 4) };
    this.structs.set(name, ty);
    return ty;
  }

  private parseType(): CType {
    if (this.matchText('int')) return { kind: 'int' };
    if (this.matchText('char')) return { kind: 'char' };
    if (this.matchText('void')) return { kind: 'void' };
    if (this.matchText('struct')) {
      const name = this.expect('id').text;
      if (this.matchText('{')) {
        this.i -= 3;
        return this.parseStructDefinition();
      }
      const ty = this.structs.get(name);
      if (!ty) throw new CompileError(`unknown struct '${name}'`, loc(this.previous()));
      return ty;
    }
    const named = this.peek();
    if (named.kind === 'id' && this.typedefs.has(named.text)) {
      this.advance();
      return this.typedefs.get(named.text)!;
    }
    throw new CompileError(`expected type, got '${this.peek().text}'`, loc(this.peek()));
  }

  private parseDeclarator(base: CType): { name: string; type: CType } {
    let type = base;
    while (this.matchText('*')) type = { kind: 'ptr', to: type };
    const name = this.expect('id').text;
    while (this.matchText('[')) {
      let len = 0;
      if (!this.matchText(']')) {
        len = this.expectNumber();
        this.expectText(']');
      }
      type = { kind: 'array', of: type, len };
    }
    return { name, type };
  }

  private parseDeclTail(
    first: { name: string; type: CType },
    allowInit = true,
  ): { name: string; type: CType; init: Initializer | null }[] {
    const out: { name: string; type: CType; init: Initializer | null }[] = [];
    let cur = first;
    for (;;) {
      let init: Initializer | null = null;
      if (allowInit && this.matchText('=')) init = this.parseInitializer();
      out.push({ name: cur.name, type: inferArrayLength(cur.type, init), init });
      if (!this.matchText(',')) break;
      cur = this.parseDeclarator(stripDeclaratorBase(cur.type));
    }
    this.expectText(';');
    return out;
  }

  private parseInitializer(): Initializer {
    if (this.peek().kind === 'str') {
      const t = this.advance();
      return { kind: 'string', value: String(t.value ?? '') };
    }
    if (this.matchText('{')) {
      const items: Initializer[] = [];
      if (!this.matchText('}')) {
        do {
          items.push(this.parseInitializer());
        } while (this.matchText(','));
        this.expectText('}');
      }
      return { kind: 'list', items };
    }
    return { kind: 'expr', expr: this.parseExpr() };
  }

  private parseParams(): Param[] {
    const params: Param[] = [];
    if (this.matchText(')')) return params;
    if (this.peekText() === 'void' && this.peekText(1) === ')') {
      this.advance();
      this.expectText(')');
      return params;
    }
    do {
      const base = this.parseType();
      const d = this.parseDeclarator(base);
      const type =
        d.type.kind === 'array' ? ({ kind: 'ptr', to: d.type.of } satisfies CType) : d.type;
      params.push({ name: d.name, type });
    } while (this.matchText(','));
    this.expectText(')');
    return params;
  }

  private parseStmt(): Stmt {
    if (this.matchText('{')) {
      const stmts: Stmt[] = [];
      while (!this.matchText('}')) stmts.push(this.parseStmt());
      return { kind: 'block', stmts };
    }
    if (this.isTypeStart()) {
      const base = this.parseType();
      const first = this.parseDeclarator(base);
      return {
        kind: 'decl',
        decls: this.parseDeclTail(first).map((d) => ({ ...d, init: initExpr(d.init) })),
      };
    }
    if (this.matchText('return')) {
      const expr = this.matchText(';') ? null : this.parseExprThenSemi();
      return { kind: 'return', expr };
    }
    if (this.matchText('if')) {
      this.expectText('(');
      const cond = this.parseExpr();
      this.expectText(')');
      const then = this.parseStmt();
      const otherwise = this.matchText('else') ? this.parseStmt() : null;
      return { kind: 'if', cond, then, otherwise };
    }
    if (this.matchText('while')) {
      this.expectText('(');
      const cond = this.parseExpr();
      this.expectText(')');
      return { kind: 'while', cond, body: this.parseStmt() };
    }
    if (this.matchText('for')) {
      this.expectText('(');
      let init: Stmt | Expr | null = null;
      if (!this.matchText(';')) {
        if (this.isTypeStart()) {
          const base = this.parseType();
          init = {
            kind: 'decl',
            decls: this.parseDeclTail(this.parseDeclarator(base)).map((d) => ({
              ...d,
              init: initExpr(d.init),
            })),
          };
        } else {
          init = this.parseExpr();
          this.expectText(';');
        }
      }
      const cond = this.matchText(';') ? null : this.parseExprThenSemi();
      const post = this.matchText(')') ? null : this.parseExprUntil(')');
      return { kind: 'for', init, cond, post, body: this.parseStmt() };
    }
    if (this.matchText('break')) {
      this.expectText(';');
      return { kind: 'break' };
    }
    if (this.matchText('continue')) {
      this.expectText(';');
      return { kind: 'continue' };
    }
    if (this.matchText('asm')) {
      this.expectText('(');
      let s = '';
      do {
        s += String(this.expect('str').value ?? '');
      } while (this.peek().kind === 'str');
      this.expectText(')');
      this.expectText(';');
      return { kind: 'asm', source: s };
    }
    if (this.matchText(';')) return { kind: 'expr', expr: null };
    return { kind: 'expr', expr: this.parseExprThenSemi() };
  }

  private parseExprThenSemi(): Expr {
    const e = this.parseExpr();
    this.expectText(';');
    return e;
  }

  private parseExprUntil(end: string): Expr {
    const e = this.parseExpr();
    this.expectText(end);
    return e;
  }

  private parseExpr(): Expr {
    return this.parseAssign();
  }

  private parseAssign(): Expr {
    const left = this.parseBinary(1);
    if (this.matchText('=')) return { kind: 'assign', left, right: this.parseAssign() };
    return left;
  }

  private parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peekText();
      const prec = precedence(op);
      if (prec < minPrec) return left;
      this.advance();
      const right = this.parseBinary(prec + 1);
      left = { kind: 'binary', op, left, right };
    }
  }

  private parseUnary(): Expr {
    if (this.matchText('sizeof')) {
      this.expectText('(');
      const ty = this.parseType();
      this.expectText(')');
      return { kind: 'sizeof', typeName: ty };
    }
    for (const op of ['&', '*', '-', '!', '~']) {
      if (this.matchText(op)) return { kind: 'unary', op, expr: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.matchText('(')) {
        const args: Expr[] = [];
        if (!this.matchText(')')) {
          do {
            args.push(this.parseExpr());
          } while (this.matchText(','));
          this.expectText(')');
        }
        // A bare name is resolved at codegen (direct call to a function, or an
        // indirect call through a variable holding an address); any other
        // expression is an indirect call through its computed address.
        e =
          e.kind === 'var'
            ? { kind: 'call', callee: e.name, args }
            : { kind: 'callptr', target: e, args };
        continue;
      }
      if (this.matchText('[')) {
        const index = this.parseExpr();
        this.expectText(']');
        e = { kind: 'index', base: e, index };
        continue;
      }
      if (this.matchText('.') || this.matchText('->')) {
        const deref = this.previous().text === '->';
        const name = this.expect('id').text;
        e = { kind: 'member', base: e, name, deref };
        continue;
      }
      return e;
    }
  }

  private parsePrimary(): Expr {
    if (this.matchText('(')) {
      const e = this.parseExpr();
      this.expectText(')');
      return e;
    }
    const t = this.advance();
    if (t.kind === 'num') return { kind: 'num', value: Number(t.value) >>> 0 };
    if (t.kind === 'char') return { kind: 'num', value: Number(t.value) >>> 0 };
    if (t.kind === 'str') return { kind: 'str', value: String(t.value ?? '') };
    if (t.kind === 'id') return { kind: 'var', name: t.text };
    throw new CompileError(`unexpected token '${t.text}'`, loc(t));
  }

  private isTypeStart(): boolean {
    const text = this.peekText();
    return (
      text === 'int' ||
      text === 'char' ||
      text === 'void' ||
      text === 'struct' ||
      this.typedefs.has(text)
    );
  }

  private expectNumber(): number {
    const t = this.expect('num');
    return Number(t.value) >>> 0;
  }

  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private matchText(text: string): boolean {
    if (this.peek().text !== text) return false;
    this.advance();
    return true;
  }

  private expectText(text: string): Token {
    const t = this.advance();
    if (t.text !== text) throw new CompileError(`expected '${text}', got '${t.text}'`, loc(t));
    return t;
  }

  private expect(kind: TokenKind): Token {
    const t = this.advance();
    if (t.kind !== kind) throw new CompileError(`expected ${kind}, got '${t.text}'`, loc(t));
    return t;
  }

  private peek(n = 0): Token {
    return this.tokens[this.i + n] ?? this.tokens[this.tokens.length - 1]!;
  }

  private peekText(n = 0): string {
    return this.peek(n).text;
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.i - 1)]!;
  }

  private advance(): Token {
    const t = this.peek();
    if (this.i < this.tokens.length) this.i++;
    return t;
  }
}

function initExpr(init: Initializer | null): Expr | null {
  if (!init) return null;
  if (init.kind !== 'expr') throw new CompileError('local initializers must be scalar expressions');
  return init.expr;
}

function inferArrayLength(type: CType, init: Initializer | null): CType {
  if (type.kind !== 'array' || type.len !== 0 || !init) return type;
  if (init.kind === 'string') return { ...type, len: init.value.length + 1 };
  if (init.kind === 'list') return { ...type, len: init.items.length };
  return type;
}

function stripDeclaratorBase(type: CType): CType {
  if (type.kind === 'array') return stripDeclaratorBase(type.of);
  if (type.kind === 'ptr') return stripDeclaratorBase(type.to);
  return type;
}

function precedence(op: string): number {
  switch (op) {
    case '||':
      return 1;
    case '&&':
      return 2;
    case '|':
      return 3;
    case '^':
      return 4;
    case '&':
      return 5;
    case '==':
    case '!=':
      return 6;
    case '<':
    case '<=':
    case '>':
    case '>=':
      return 7;
    case '<<':
    case '>>':
      return 8;
    case '+':
    case '-':
      return 9;
    case '*':
    case '/':
    case '%':
      return 10;
    default:
      return -1;
  }
}

function typeSize(type: CType): number {
  switch (type.kind) {
    case 'void':
      return 0;
    case 'char':
      return 1;
    case 'int':
    case 'ptr':
      return 4;
    case 'array':
      return typeSize(type.of) * type.len;
    case 'struct':
      return type.size;
    case 'funcptr':
      return 4;
  }
}

function typeAlign(type: CType): number {
  return type.kind === 'char' ? 1 : 4;
}

// Stride for pointer arithmetic: the size of the pointed-to element (>= 1).
function elementSize(type: CType): number {
  return type.kind === 'ptr' ? Math.max(1, typeSize(type.to)) : 1;
}

function align(n: number, a: number): number {
  return (n + a - 1) & ~(a - 1);
}

function wordBytes(value: number): number[] {
  const u = value >>> 0;
  return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff];
}

let moduleSeq = 0;

class Codegen {
  private out: string[] = [];
  private labelId = 0;
  private globals = new Map<string, CType>();
  private functions = new Map<string, FunctionSig>();
  private scopes: Map<string, LocalDecl>[] = [];
  private readonly modulePrefix: string;
  private currentReturn = '';
  private breakStack: string[] = [];
  private continueStack: string[] = [];
  private stringLiterals: DataSymbol[] = [];
  private sourceMap = new Map<string, SourceLocation>();
  private readonly program: Program;
  private readonly options: Required<CompileOptions>;

  constructor(program: Program, options: Required<CompileOptions>) {
    this.program = program;
    this.options = options;
    const id = options.moduleId === '' ? moduleSeq++ : options.moduleId;
    this.modulePrefix = `m${id}`;
  }

  compile(): CompiledObject {
    for (const g of this.program.globals) this.globals.set(g.name, g.type);
    for (const f of this.program.prototypes) {
      this.registerFunction(f);
    }
    for (const f of this.program.functions) {
      this.registerFunction(f);
    }

    if (this.options.start !== 'none') this.emitStart();
    for (const f of this.program.functions) this.emitFunction(f);
    if (this.options.includeRuntime) this.emitRuntime();

    const { data, bss } = this.emitGlobals();
    data.push(...this.stringLiterals);
    bss.push({ name: '__stack', size: this.options.cStackSize });
    data.push({ name: '__csp', bytes: new Uint8Array(4), size: 4 });
    data.push({ name: 'environ', bytes: new Uint8Array(4), size: 4 });

    return {
      name: 'c-object',
      text: this.out.join('\n'),
      data,
      bss,
      globals: this.globals,
      functions: this.functions,
      sourceMap: this.sourceMap,
    };
  }

  private registerFunction(sig: FunctionSig): void {
    const prior = this.functions.get(sig.name);
    if (prior && !functionTypesEqual(prior, sig)) {
      throw new CompileError(`conflicting function declarations for ${sig.name}`);
    }
    this.functions.set(sig.name, {
      name: sig.name,
      returnType: sig.returnType,
      params: sig.params,
    });
  }

  private emitStart(): void {
    const entry = this.options.entry;
    this.emit(`_start:`);
    this.emit(`  MOV R5, __stack`);
    this.emit(`  STORE R5, __csp`);
    if (this.options.start === 'user') {
      this.emit(`  STORE R2, environ`);
      this.emitPushValueFromReg('R0');
      this.emitPushValueFromReg('R1');
      this.emit(`  CALL ${entry}`);
      this.emitAdjustCsp(-8);
      this.emit(`  MOVR R1, R0`);
      this.emit(`  MOV R0, ${SYS.EXIT}`);
      this.emit(`  INT ${SYSCALL_INT}`);
    } else {
      this.emit(`  CALL ${entry}`);
      this.emit(`  HLT`);
    }
  }

  private emitFunction(fn: FuncDecl): void {
    const paramScope = new Map<string, LocalDecl>();
    const paramBytes = fn.params.length * 4;
    for (let i = 0; i < fn.params.length; i++) {
      const p = fn.params[i]!;
      paramScope.set(p.name, {
        name: p.name,
        type: p.type,
        init: null,
        offset: -(paramBytes - i * 4),
      });
    }
    this.scopes = [paramScope];
    const localBytes = this.assignLocalOffsets(fn.body);
    const end = this.newLabel(`${fn.name}_return`);
    this.currentReturn = end;
    this.sourceMap.set(fn.name, fn.loc);
    this.emit(`${fn.name}:`);
    this.emit(`  PUSH R6`);
    this.emit(`  LOAD R6, __csp`);
    if (localBytes > 0) {
      this.emit(`  MOVR R5, R6`);
      this.emit(`  MOV R7, ${localBytes}`);
      this.emit(`  ADD R5, R7`);
      this.emit(`  STORE R5, __csp`);
    }
    this.emitStmt(fn.body);
    if (fn.returnType.kind === 'void') this.emit(`  MOV R0, 0`);
    this.emit(`${end}:`);
    this.emit(`  STORE R6, __csp`);
    this.emit(`  POP R6`);
    this.emit(`  RET`);
  }

  private assignLocalOffsets(stmt: Stmt): number {
    let offset = 0;
    const visit = (s: Stmt) => {
      switch (s.kind) {
        case 'block':
          for (const child of s.stmts) visit(child);
          break;
        case 'decl':
          // Assign each declaration a distinct slot. Storage never overlaps,
          // so block scoping (resolved during emission) makes shadowing safe.
          for (const d of s.decls) {
            offset = align(offset, Math.min(typeAlign(d.type), 4));
            d.offset = offset;
            offset += align(Math.max(1, typeSize(d.type)), 4);
          }
          break;
        case 'if':
          visit(s.then);
          if (s.otherwise) visit(s.otherwise);
          break;
        case 'while':
          visit(s.body);
          break;
        case 'for':
          if (s.init && typeof s.init === 'object' && 'kind' in s.init && s.init.kind === 'decl') {
            visit(s.init);
          }
          visit(s.body);
          break;
      }
    };
    visit(stmt);
    return align(offset, 4);
  }

  private emitStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'block':
        this.scopes.push(new Map());
        for (const s of stmt.stmts) this.emitStmt(s);
        this.scopes.pop();
        break;
      case 'decl':
        for (const d of stmt.decls) {
          this.currentScope().set(d.name, d);
          if (d.init) {
            this.emitAddressOfLocal(d);
            this.emit(`  PUSH R0`);
            this.emitExpr(d.init);
            this.emit(`  POP R1`);
            this.storeToAddress(d.type, 'R1', 'R0');
          }
        }
        break;
      case 'expr':
        if (stmt.expr) this.emitExpr(stmt.expr);
        break;
      case 'return':
        if (stmt.expr) this.emitExpr(stmt.expr);
        else this.emit(`  MOV R0, 0`);
        this.emit(`  JMP ${this.currentReturn}`);
        break;
      case 'if': {
        const els = this.newLabel('else');
        const done = this.newLabel('endif');
        this.emitExpr(stmt.cond);
        this.emit(`  MOV R7, 0`);
        this.emit(`  CMP R0, R7`);
        this.emit(`  JZ ${els}`);
        this.emitStmt(stmt.then);
        this.emit(`  JMP ${done}`);
        this.emit(`${els}:`);
        if (stmt.otherwise) this.emitStmt(stmt.otherwise);
        this.emit(`${done}:`);
        break;
      }
      case 'while': {
        const top = this.newLabel('while');
        const done = this.newLabel('endwhile');
        this.breakStack.push(done);
        this.continueStack.push(top);
        this.emit(`${top}:`);
        this.emitExpr(stmt.cond);
        this.emit(`  MOV R7, 0`);
        this.emit(`  CMP R0, R7`);
        this.emit(`  JZ ${done}`);
        this.emitStmt(stmt.body);
        this.emit(`  JMP ${top}`);
        this.emit(`${done}:`);
        this.breakStack.pop();
        this.continueStack.pop();
        break;
      }
      case 'for': {
        const top = this.newLabel('for');
        const post = this.newLabel('forpost');
        const done = this.newLabel('endfor');
        // A declaration in the init clause is scoped to the loop only.
        this.scopes.push(new Map());
        if (stmt.init) {
          if ('stmts' in stmt.init || stmt.init.kind === 'decl') this.emitStmt(stmt.init as Stmt);
          else this.emitExpr(stmt.init as Expr);
        }
        this.breakStack.push(done);
        this.continueStack.push(post);
        this.emit(`${top}:`);
        if (stmt.cond) {
          this.emitExpr(stmt.cond);
          this.emit(`  MOV R7, 0`);
          this.emit(`  CMP R0, R7`);
          this.emit(`  JZ ${done}`);
        }
        this.emitStmt(stmt.body);
        this.emit(`${post}:`);
        if (stmt.post) this.emitExpr(stmt.post);
        this.emit(`  JMP ${top}`);
        this.emit(`${done}:`);
        this.breakStack.pop();
        this.continueStack.pop();
        this.scopes.pop();
        break;
      }
      case 'break':
        this.emit(`  JMP ${this.breakStack.at(-1) ?? this.fail('break outside loop')}`);
        break;
      case 'continue':
        this.emit(`  JMP ${this.continueStack.at(-1) ?? this.fail('continue outside loop')}`);
        break;
      case 'asm':
        for (const line of stmt.source.split('\n')) {
          if (line.trim() !== '') this.emit(`  ${line.trim()}`);
        }
        break;
    }
  }

  private emitExpr(expr: Expr): CType {
    switch (expr.kind) {
      case 'num':
        this.emit(`  MOV R0, ${expr.value >>> 0}`);
        expr.type = { kind: 'int' };
        return expr.type;
      case 'str': {
        if (!expr.label) expr.label = this.internString(expr.value);
        this.emit(`  MOV R0, ${expr.label}`);
        expr.type = { kind: 'ptr', to: { kind: 'char' } };
        return expr.type;
      }
      case 'var': {
        // A function name used as a value yields its address (e.g. for a
        // dispatch table), unless a variable of the same name shadows it.
        if (
          this.functions.has(expr.name) &&
          !this.lookupLocal(expr.name) &&
          !this.globals.has(expr.name)
        ) {
          this.emit(`  MOV R0, ${expr.name}`);
          expr.type = { kind: 'ptr', to: { kind: 'int' } };
          return expr.type;
        }
        const type = this.resolveVar(expr.name);
        if (type.kind === 'array') {
          this.emitAddressOf(expr);
          expr.type = { kind: 'ptr', to: type.of };
          return expr.type;
        }
        this.emitAddressOf(expr);
        this.loadFromAddress(type, 'R0', 'R0');
        expr.type = type;
        return type;
      }
      case 'assign': {
        const ty = this.emitAddressOf(expr.left);
        this.emit(`  PUSH R0`);
        const rhs = this.emitExpr(expr.right);
        this.emit(`  POP R1`);
        this.storeToAddress(ty, 'R1', 'R0');
        expr.type = rhs;
        return rhs;
      }
      case 'unary':
        return this.emitUnary(expr);
      case 'binary':
        return this.emitBinary(expr);
      case 'call':
        return this.emitCall(expr);
      case 'callptr':
        return this.emitCallPtr(expr);
      case 'index': {
        const ty = this.emitAddressOf(expr);
        if (ty.kind === 'array') {
          expr.type = { kind: 'ptr', to: ty.of };
          return expr.type;
        }
        this.loadFromAddress(ty, 'R0', 'R0');
        expr.type = ty;
        return ty;
      }
      case 'member': {
        const ty = this.emitAddressOf(expr);
        if (ty.kind === 'array') {
          expr.type = { kind: 'ptr', to: ty.of };
          return expr.type;
        }
        this.loadFromAddress(ty, 'R0', 'R0');
        expr.type = ty;
        return ty;
      }
      case 'sizeof':
        this.emit(`  MOV R0, ${typeSize(expr.typeName)}`);
        expr.type = { kind: 'int' };
        return expr.type;
    }
  }

  private emitUnary(expr: Extract<Expr, { kind: 'unary' }>): CType {
    if (expr.op === '&') {
      const ty = this.emitAddressOf(expr.expr);
      expr.type = { kind: 'ptr', to: ty };
      return expr.type;
    }
    if (expr.op === '*') {
      const inner = this.emitExpr(expr.expr);
      const ty = inner.kind === 'ptr' ? inner.to : ({ kind: 'int' } satisfies CType);
      if (ty.kind !== 'array') this.loadFromAddress(ty, 'R0', 'R0');
      expr.type = ty;
      return ty;
    }
    this.emitExpr(expr.expr);
    if (expr.op === '-') {
      this.emit(`  MOV R1, 0`);
      this.emit(`  SUB R1, R0`);
      this.emit(`  MOVR R0, R1`);
    } else if (expr.op === '!') {
      const yes = this.newLabel('not_true');
      const done = this.newLabel('not_done');
      this.emit(`  MOV R7, 0`);
      this.emit(`  CMP R0, R7`);
      this.emit(`  JZ ${yes}`);
      this.emit(`  MOV R0, 0`);
      this.emit(`  JMP ${done}`);
      this.emit(`${yes}:`);
      this.emit(`  MOV R0, 1`);
      this.emit(`${done}:`);
    } else if (expr.op === '~') {
      this.emit(`  NOT R0`);
    }
    expr.type = { kind: 'int' };
    return expr.type;
  }

  private emitBinary(expr: Extract<Expr, { kind: 'binary' }>): CType {
    if (expr.op === '&&' || expr.op === '||') return this.emitLogical(expr);

    const lt = this.emitExpr(expr.left);
    this.emit(`  PUSH R0`);
    const rt = this.emitExpr(expr.right);
    this.emit(`  POP R1`);
    // After this point: R1 = left, R0 = right.
    let resultType: CType = { kind: 'int' };
    switch (expr.op) {
      case '+':
        // Pointer + integer (or integer + pointer) scales the integer side by
        // the pointee size, matching C pointer arithmetic.
        if (lt.kind === 'ptr' && rt.kind !== 'ptr') {
          this.scaleReg('R0', elementSize(lt));
          resultType = lt;
        } else if (rt.kind === 'ptr' && lt.kind !== 'ptr') {
          this.scaleReg('R1', elementSize(rt));
          resultType = rt;
        }
        this.emit(`  ADD R0, R1`);
        break;
      case '-':
        if (lt.kind === 'ptr' && rt.kind === 'ptr') {
          // Pointer difference: byte distance divided by the pointee size.
          this.emit(`  SUB R1, R0`);
          this.emit(`  MOVR R0, R1`);
          this.scaleDivReg('R0', elementSize(lt));
        } else {
          if (lt.kind === 'ptr' && rt.kind !== 'ptr') {
            this.scaleReg('R0', elementSize(lt));
            resultType = lt;
          }
          this.emit(`  SUB R1, R0`);
          this.emit(`  MOVR R0, R1`);
        }
        break;
      case '*':
        this.emit(`  MUL R0, R1`);
        break;
      case '/':
        this.emit(`  MOVR R2, R0`);
        this.emit(`  MOVR R0, R1`);
        this.emit(`  IDIV R0, R2`);
        break;
      case '%':
        this.emit(`  MOVR R2, R0`);
        this.emit(`  MOVR R0, R1`);
        this.emit(`  IMOD R0, R2`);
        break;
      case '&':
        this.emit(`  AND R0, R1`);
        break;
      case '|':
        this.emit(`  OR R0, R1`);
        break;
      case '^':
        this.emit(`  XOR R0, R1`);
        break;
      case '<<':
        this.emit(`  MOVR R2, R0`);
        this.emit(`  MOVR R0, R1`);
        this.emit(`  SHL R0, R2`);
        break;
      case '>>':
        this.emit(`  MOVR R2, R0`);
        this.emit(`  MOVR R0, R1`);
        this.emit(`  SAR R0, R2`);
        break;
      case '==':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        this.emitCompare(expr.op);
        break;
      default:
        this.fail(`unsupported binary operator ${expr.op}`);
    }
    expr.type = resultType;
    return resultType;
  }

  // Short-circuit `&&` / `||`: the right operand is only evaluated when the
  // left does not already decide the result. The value is normalized to 0/1.
  private emitLogical(expr: Extract<Expr, { kind: 'binary' }>): CType {
    const set = this.newLabel('logic_set');
    const done = this.newLabel('logic_done');
    this.emitExpr(expr.left);
    this.emit(`  MOV R7, 0`);
    this.emit(`  CMP R0, R7`);
    if (expr.op === '&&') {
      // left == 0 -> result 0 without touching the right operand.
      this.emit(`  JZ ${set}`);
    } else {
      // left != 0 -> result 1 without touching the right operand.
      this.emit(`  JNZ ${set}`);
    }
    this.emitExpr(expr.right);
    this.emit(`  MOV R7, 0`);
    this.emit(`  CMP R0, R7`);
    if (expr.op === '&&') this.emit(`  JZ ${set}`);
    else this.emit(`  JNZ ${set}`);
    this.emit(`  MOV R0, ${expr.op === '&&' ? 1 : 0}`);
    this.emit(`  JMP ${done}`);
    this.emit(`${set}:`);
    this.emit(`  MOV R0, ${expr.op === '&&' ? 0 : 1}`);
    this.emit(`${done}:`);
    expr.type = { kind: 'int' };
    return expr.type;
  }

  private scaleReg(reg: string, size: number): void {
    if (size === 1) return;
    this.emit(`  MOV R7, ${size}`);
    this.emit(`  MUL ${reg}, R7`);
  }

  private scaleDivReg(reg: string, size: number): void {
    if (size === 1) return;
    this.emit(`  MOV R7, ${size}`);
    this.emit(`  DIV ${reg}, R7`);
  }

  private emitCompare(op: string): void {
    const yes = this.newLabel('cmp_true');
    const done = this.newLabel('cmp_done');
    this.emit(`  CMP R1, R0`);
    const jump: Record<string, string> = {
      '==': 'JZ',
      '!=': 'JNZ',
      '<': 'JL',
      '<=': 'JLE',
      '>': 'JG',
      '>=': 'JGE',
    };
    this.emit(`  ${jump[op]} ${yes}`);
    this.emit(`  MOV R0, 0`);
    this.emit(`  JMP ${done}`);
    this.emit(`${yes}:`);
    this.emit(`  MOV R0, 1`);
    this.emit(`${done}:`);
  }

  private emitCall(expr: Extract<Expr, { kind: 'call' }>): CType {
    if (expr.callee.startsWith('__')) {
      return this.emitBuiltin(expr);
    }
    // An indirect call happens only when the name is a variable (local/global)
    // holding an address and is not itself a function. Everything else -- known
    // functions, runtime helpers, and external labels -- is a direct call.
    const isVar = !!this.lookupLocal(expr.callee) || this.globals.has(expr.callee);
    const indirect = isVar && !this.functions.has(expr.callee);
    const variableType = indirect ? this.resolveVar(expr.callee) : undefined;
    for (const arg of expr.args) {
      this.emitExpr(arg);
      this.emitPushValueFromReg('R0');
    }
    if (indirect) {
      this.emitExpr({ kind: 'var', name: expr.callee }); // address into R0
      this.emit(`  CALLR R0`);
    } else {
      this.emit(`  CALL ${expr.callee}`);
    }
    if (expr.args.length > 0) this.emitAdjustCsp(-expr.args.length * 4);
    const sig = this.functions.get(expr.callee);
    expr.type =
      indirect && variableType?.kind === 'funcptr'
        ? variableType.returnType
        : (sig?.returnType ?? { kind: 'int' });
    return expr.type;
  }

  // Indirect call through a computed address (e.g. `table[i](args)`). The target
  // is evaluated after the arguments are staged. A typed function pointer
  // preserves its declared return type for subsequent pointer arithmetic and
  // dereferences.
  private emitCallPtr(expr: Extract<Expr, { kind: 'callptr' }>): CType {
    for (const arg of expr.args) {
      this.emitExpr(arg);
      this.emitPushValueFromReg('R0');
    }
    const targetType = this.emitExpr(expr.target); // address into R0
    this.emit(`  CALLR R0`);
    if (expr.args.length > 0) this.emitAdjustCsp(-expr.args.length * 4);
    expr.type = targetType.kind === 'funcptr' ? targetType.returnType : { kind: 'int' };
    return expr.type;
  }

  private emitBuiltin(expr: Extract<Expr, { kind: 'call' }>): CType {
    const args = expr.args;
    const evalIntoRegs = (regs: string[]) => {
      for (const arg of args) {
        this.emitExpr(arg);
        this.emit(`  PUSH R0`);
      }
      for (let i = Math.min(args.length, regs.length) - 1; i >= 0; i--) {
        this.emit(`  POP ${regs[i]}`);
      }
      for (let i = args.length; i < regs.length; i++) this.emit(`  MOV ${regs[i]}, 0`);
    };
    switch (expr.callee) {
      case '__syscall':
        evalIntoRegs(['R0', 'R1', 'R2', 'R3']);
        this.emit(`  INT ${SYSCALL_INT}`);
        break;
      case '__out':
        evalIntoRegs(['R1', 'R2']);
        this.emit(`  OUT R1, R2`);
        this.emit(`  MOV R0, 0`);
        break;
      case '__in':
        evalIntoRegs(['R1']);
        this.emit(`  IN R0, R1`);
        break;
      case '__halt':
        this.emit(`  HLT`);
        this.emit(`  MOV R0, 0`);
        break;
      case '__iret':
        this.emit(`  IRET`);
        this.emit(`  MOV R0, 0`);
        break;
      case '__lidt':
        evalIntoRegs(['R1']);
        this.emit(`  LIDT R1`);
        this.emit(`  MOV R0, 0`);
        break;
      case '__lksp':
        evalIntoRegs(['R1']);
        this.emit(`  LKSP R1`);
        this.emit(`  MOV R0, 0`);
        break;
      case '__stmr':
        evalIntoRegs(['R1']);
        this.emit(`  STMR R1`);
        this.emit(`  MOV R0, 0`);
        break;
      case '__lptbr':
        evalIntoRegs(['R1']);
        this.emit(`  LPTBR R1`);
        this.emit(`  MOV R0, 0`);
        break;
      case '__pgon':
        this.emit(`  PGON`);
        this.emit(`  MOV R0, 0`);
        break;
      case '__pgoff':
        this.emit(`  PGOFF`);
        this.emit(`  MOV R0, 0`);
        break;
      case '__rdpfla':
        this.emit(`  RDPFLA R0`);
        break;
      case '__rderr':
        this.emit(`  RDERR R0`);
        break;
      case '__ei':
        this.emit(`  EI`);
        this.emit(`  MOV R0, 0`);
        break;
      case '__di':
        this.emit(`  DI`);
        this.emit(`  MOV R0, 0`);
        break;
      default:
        this.fail(`unknown builtin ${expr.callee}`);
    }
    expr.type = { kind: 'int' };
    return expr.type;
  }

  private emitAddressOf(expr: Expr): CType {
    switch (expr.kind) {
      case 'var': {
        const local = this.lookupLocal(expr.name);
        if (local) {
          this.emitAddressOfLocal(local);
          return local.type;
        }
        const global = this.globals.get(expr.name);
        if (global) {
          this.emit(`  MOV R0, ${expr.name}`);
          return global;
        }
        return this.fail(`unknown variable ${expr.name}`);
      }
      case 'unary':
        if (expr.op === '*') {
          const ty = this.emitExpr(expr.expr);
          return ty.kind === 'ptr' ? ty.to : ({ kind: 'int' } satisfies CType);
        }
        break;
      case 'index': {
        const baseType = this.emitExpr(expr.base);
        const elem =
          baseType.kind === 'ptr'
            ? baseType.to
            : baseType.kind === 'array'
              ? baseType.of
              : ({ kind: 'int' } satisfies CType);
        this.emit(`  PUSH R0`);
        this.emitExpr(expr.index);
        const sz = Math.max(1, typeSize(elem));
        if (sz !== 1) {
          this.emit(`  MOV R7, ${sz}`);
          this.emit(`  MUL R0, R7`);
        }
        this.emit(`  POP R1`);
        this.emit(`  ADD R0, R1`);
        return elem;
      }
      case 'member': {
        let baseType: CType;
        if (expr.deref) {
          baseType = this.emitExpr(expr.base);
          if (baseType.kind === 'ptr') baseType = baseType.to;
        } else {
          baseType = this.emitAddressOf(expr.base);
        }
        if (baseType.kind !== 'struct') this.fail(`member access on non-struct`);
        const field = baseType.fields.find((f) => f.name === expr.name);
        if (!field) this.fail(`no field '${expr.name}' in struct ${baseType.name}`);
        if (field.offset !== 0) {
          this.emit(`  MOV R7, ${field.offset}`);
          this.emit(`  ADD R0, R7`);
        }
        return field.type;
      }
    }
    this.fail('expression is not addressable');
  }

  private emitAddressOfLocal(local: LocalDecl): void {
    const offset = local.offset ?? 0;
    this.emit(`  MOVR R0, R6`);
    if (offset > 0) {
      this.emit(`  MOV R7, ${offset}`);
      this.emit(`  ADD R0, R7`);
    } else if (offset < 0) {
      this.emit(`  MOV R7, ${-offset}`);
      this.emit(`  SUB R0, R7`);
    }
  }

  private loadFromAddress(type: CType, dst: string, addr: string): void {
    if (type.kind === 'char') this.emit(`  LB ${dst}, ${addr}`);
    else this.emit(`  LOADR ${dst}, ${addr}`);
  }

  private storeToAddress(type: CType, addr: string, src: string): void {
    if (type.kind === 'char') this.emit(`  SB ${addr}, ${src}`);
    else this.emit(`  STORER ${addr}, ${src}`);
  }

  private resolveVar(name: string): CType {
    const local = this.lookupLocal(name);
    if (local) return local.type;
    const global = this.globals.get(name);
    if (global) return global;
    this.fail(`unknown variable ${name}`);
  }

  private currentScope(): Map<string, LocalDecl> {
    return this.scopes[this.scopes.length - 1]!;
  }

  private lookupLocal(name: string): LocalDecl | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i]!.get(name);
      if (found) return found;
    }
    return undefined;
  }

  private emitPushValueFromReg(reg: string): void {
    this.emit(`  LOAD R5, __csp`);
    this.emit(`  STORER R5, ${reg}`);
    this.emit(`  MOV R7, 4`);
    this.emit(`  ADD R5, R7`);
    this.emit(`  STORE R5, __csp`);
  }

  private emitAdjustCsp(delta: number): void {
    this.emit(`  LOAD R5, __csp`);
    this.emit(`  MOV R7, ${Math.abs(delta)}`);
    if (delta >= 0) this.emit(`  ADD R5, R7`);
    else this.emit(`  SUB R5, R7`);
    this.emit(`  STORE R5, __csp`);
  }

  private emitGlobals(): { data: DataSymbol[]; bss: BssSymbol[] } {
    const data: DataSymbol[] = [];
    const bss: BssSymbol[] = [];
    for (const g of this.program.globals) {
      if (g.extern) continue; // declared here, defined (and allocated) elsewhere
      const size = Math.max(1, typeSize(g.type));
      if (!g.init) {
        bss.push({ name: g.name, size: align(size, 4) });
        continue;
      }
      // A pointer global initialized from a string literal or the address of
      // another global stores a relocatable address, resolved by the linker.
      if (g.type.kind === 'ptr') {
        const target = this.globalPointerTarget(g.init);
        if (target !== null) {
          data.push({
            name: g.name,
            bytes: new Uint8Array(4),
            size: 4,
            relocs: [{ offset: 0, target }],
          });
          continue;
        }
      }
      data.push({ name: g.name, bytes: initializerBytes(g.type, g.init), size });
    }
    return { data, bss };
  }

  // Resolves a pointer global's initializer to the symbol it should point at,
  // or null when the initializer is an ordinary constant (e.g. `0`).
  private globalPointerTarget(init: Initializer): string | null {
    if (init.kind === 'string') return this.internString(init.value);
    if (init.kind !== 'expr') return null;
    const e = init.expr;
    if (e.kind === 'str') return this.internString(e.value);
    if (
      e.kind === 'unary' &&
      e.op === '&' &&
      e.expr.kind === 'var' &&
      this.globals.has(e.expr.name)
    ) {
      return e.expr.name;
    }
    if (e.kind === 'var') {
      const gt = this.globals.get(e.name);
      if (gt && gt.kind === 'array') return e.name; // array decays to a pointer
    }
    return null;
  }

  private internString(value: string): string {
    const label = this.newLabel('__str');
    const raw = encoder.encode(value);
    const bytes = new Uint8Array(raw.length + 1);
    bytes.set(raw);
    this.stringLiterals.push({ name: label, bytes, size: bytes.length });
    return label;
  }

  private emitRuntime(): void {
    this.out.push(RUNTIME_ASM.trim());
  }

  private emit(line: string): void {
    this.out.push(line);
  }

  private newLabel(prefix: string): string {
    return `${this.modulePrefix}_${prefix}_${this.labelId++}`;
  }

  private fail(message: string): never {
    throw new CompileError(message);
  }
}

export function cTypesEqual(left: CType, right: CType): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'void':
    case 'int':
    case 'char':
      return true;
    case 'ptr':
      return right.kind === 'ptr' && cTypesEqual(left.to, right.to);
    case 'array':
      return right.kind === 'array' && left.len === right.len && cTypesEqual(left.of, right.of);
    case 'struct':
      return (
        right.kind === 'struct' &&
        left.name === right.name &&
        left.size === right.size &&
        left.fields.length === right.fields.length &&
        left.fields.every((field, i) => {
          const other = right.fields[i];
          return (
            other !== undefined &&
            field.name === other.name &&
            field.offset === other.offset &&
            cTypesEqual(field.type, other.type)
          );
        })
      );
    case 'funcptr':
      return (
        right.kind === 'funcptr' &&
        cTypesEqual(left.returnType, right.returnType) &&
        paramsEqual(left.params, right.params)
      );
  }
}

export function functionTypesEqual(left: FunctionSig, right: FunctionSig): boolean {
  return cTypesEqual(left.returnType, right.returnType) && paramsEqual(left.params, right.params);
}

function paramsEqual(left: Param[], right: Param[]): boolean {
  return (
    left.length === right.length &&
    left.every((param, i) => {
      const other = right[i];
      return other !== undefined && cTypesEqual(param.type, other.type);
    })
  );
}

function initializerBytes(type: CType, init: Initializer): Uint8Array {
  const size = Math.max(1, typeSize(type));
  const bytes = new Uint8Array(align(size, 4));
  const put = (at: number, value: number, ty: CType) => {
    if (ty.kind === 'char') bytes[at] = value & 0xff;
    else bytes.set(wordBytes(value), at);
  };
  const fill = (ty: CType, value: Initializer, at: number) => {
    if (value.kind === 'string') {
      const raw = encoder.encode(value.value);
      bytes.set(raw.subarray(0, Math.max(0, typeSize(ty) - 1)), at);
      return;
    }
    if (value.kind === 'expr') {
      if (value.expr.kind !== 'num') {
        throw new CompileError(
          'global initializers must be integer constants, string literals, or addresses of globals',
        );
      }
      put(at, value.expr.value, ty);
      return;
    }
    if (ty.kind === 'array') {
      for (let i = 0; i < value.items.length; i++)
        fill(ty.of, value.items[i]!, at + i * typeSize(ty.of));
      return;
    }
    if (ty.kind === 'struct') {
      for (let i = 0; i < value.items.length; i++) {
        const field = ty.fields[i];
        if (field) fill(field.type, value.items[i]!, at + field.offset);
      }
      return;
    }
  };
  fill(type, init, 0);
  return bytes;
}

export function compileC(source: string, options: CompileOptions = {}): CompiledObject {
  const opts: Required<CompileOptions> = {
    start: options.start ?? 'user',
    entry: options.entry ?? (options.start === 'kernel' ? 'kmain' : 'main'),
    includeRuntime: options.includeRuntime ?? true,
    cStackSize: options.cStackSize ?? 4096,
    // '' is the sentinel for "assign a process-unique id at construction".
    moduleId: options.moduleId ?? '',
  };
  const tokens = new Lexer(source).tokenize();
  const program = new Parser(tokens).parseProgram();
  return new Codegen(program, opts).compile();
}

const RUNTIME_ASM = `
memcpy:
  PUSH R6
  LOAD R6, __csp
  MOVR R1, R6
  MOV R7, 12
  SUB R1, R7
  LOADR R2, R1
  MOVR R1, R6
  MOV R7, 8
  SUB R1, R7
  LOADR R3, R1
  MOVR R1, R6
  MOV R7, 4
  SUB R1, R7
  LOADR R4, R1
  MOVR R0, R2
memcpy_loop:
  MOV R7, 0
  CMP R4, R7
  JZ memcpy_done
  LB R5, R3
  SB R2, R5
  INC R2
  INC R3
  DEC R4
  JMP memcpy_loop
memcpy_done:
  STORE R6, __csp
  POP R6
  RET

memset:
  PUSH R6
  LOAD R6, __csp
  MOVR R1, R6
  MOV R7, 12
  SUB R1, R7
  LOADR R2, R1
  MOVR R1, R6
  MOV R7, 8
  SUB R1, R7
  LOADR R3, R1
  MOVR R1, R6
  MOV R7, 4
  SUB R1, R7
  LOADR R4, R1
  MOVR R0, R2
memset_loop:
  MOV R7, 0
  CMP R4, R7
  JZ memset_done
  SB R2, R3
  INC R2
  DEC R4
  JMP memset_loop
memset_done:
  STORE R6, __csp
  POP R6
  RET

strlen:
  PUSH R6
  LOAD R6, __csp
  MOVR R1, R6
  MOV R7, 4
  SUB R1, R7
  LOADR R2, R1
  MOV R0, 0
strlen_loop:
  LB R3, R2
  MOV R7, 0
  CMP R3, R7
  JZ strlen_done
  INC R0
  INC R2
  JMP strlen_loop
strlen_done:
  STORE R6, __csp
  POP R6
  RET

strcmp:
  PUSH R6
  LOAD R6, __csp
  MOVR R1, R6
  MOV R7, 8
  SUB R1, R7
  LOADR R2, R1
  MOVR R1, R6
  MOV R7, 4
  SUB R1, R7
  LOADR R3, R1
strcmp_loop:
  LB R4, R2
  LB R5, R3
  CMP R4, R5
  JNZ strcmp_diff
  MOV R7, 0
  CMP R4, R7
  JZ strcmp_eq
  INC R2
  INC R3
  JMP strcmp_loop
strcmp_diff:
  MOVR R0, R4
  SUB R0, R5
  JMP strcmp_done
strcmp_eq:
  MOV R0, 0
strcmp_done:
  STORE R6, __csp
  POP R6
  RET
`;

export const CLib = {
  SYS,
  PORT,
  SYSCALL_INT,
} as const;
