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
  type Member,
  pointerTo,
  structType,
  type Type,
  tyChar,
  tyInt,
  tyLong,
  tyShort,
  tyUChar,
  tyUInt,
  tyULong,
  tyUShort,
  tyVoid,
  unionType,
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
  | 'continue'
  | 'member'
  | 'cast';

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
  funcExpr?: Node;
  builtin?: string; // intrinsic name (e.g. __syscall) when set
  args?: Node[];
  funcReturn?: Type;
  // Struct/union member access.
  member?: Member;
  // Cast target type.
  castType?: Type;
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
  isTypedef: boolean;
}

function align(n: number, a: number): number {
  return Math.floor((n + a - 1) / a) * a;
}

class Parser {
  private pos = 0;
  private readonly globals = new Map<string, Obj>();
  private readonly objects: Obj[] = [];
  private scopes: Map<string, Obj>[] = [new Map()];
  private typedefScopes: Map<string, Type>[] = [new Map()];
  private enumScopes: Map<string, number>[] = [new Map()];
  private tagScopes: Map<string, Type>[] = [new Map()];
  private currentFn: Obj | null = null;
  private strCount = 0;
  private staticCount = 0;
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
    if (t.kind === 'ident') return this.findTypedef(t.text) !== undefined;
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
      'typedef',
      'enum',
      'struct',
      'union',
    ].includes(t.text);
  }

  // declspec = (storage-class | type-keyword)*
  private declspec(): DeclSpec {
    let isStatic = false;
    let isExtern = false;
    let isTypedef = false;
    let hasChar = false;
    let hasShort = false;
    let hasLong = false;
    let hasInt = false;
    let hasVoid = false;
    let isUnsigned = false;
    let count = 0;
    let userType: Type | undefined;

    while (this.peek().kind === 'keyword' || this.peek().kind === 'ident') {
      if (this.peek().kind === 'ident') {
        const found = this.findTypedef(this.peek().text);
        if (!found || count > 0) break;
        userType = found;
        this.pos++;
        count++;
        continue;
      }

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
      if (word === 'typedef') {
        isTypedef = true;
        this.pos++;
        continue;
      }
      if (word === 'enum') {
        userType = this.enumSpecifier();
        count++;
        continue;
      }
      if (word === 'struct' || word === 'union') {
        userType = this.structUnionDecl(word);
        count++;
        continue;
      }
      if (word === 'unsigned' || word === 'signed') {
        if (word === 'unsigned') isUnsigned = true;
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

    if (count === 0 && !isStatic && !isExtern && !isTypedef) {
      this.error('expected a type specifier');
    }

    let ty: Type;
    if (userType) ty = userType;
    else if (hasVoid) ty = tyVoid;
    else if (hasChar) ty = isUnsigned ? tyUChar : tyChar;
    else if (hasShort) ty = isUnsigned ? tyUShort : tyShort;
    else if (hasLong) ty = isUnsigned ? tyULong : tyLong;
    else ty = isUnsigned ? tyUInt : tyInt; // plain int, or `unsigned`/`signed` only
    void hasInt;
    return { ty, isStatic, isExtern, isTypedef };
  }

  private enumSpecifier(): Type {
    this.expect('enum');
    let tag: string | undefined;
    if (this.peek().kind === 'ident') {
      tag = this.peek().text;
      this.pos++;
    }

    if (!this.consume('{')) {
      if (!tag) this.error('expected an enum tag');
      const found = this.findTag(tag);
      if (!found) this.error(`unknown enum tag '${tag}'`);
      return found;
    }

    let value = 0;
    for (;;) {
      if (this.consume('}')) break;
      const name = this.expectIdent();
      if (this.consume('=')) value = this.evalConst(this.assign());
      this.currentEnumScope().set(name, value | 0);
      value++;
      if (this.consume(',')) {
        if (this.consume('}')) break;
        continue;
      }
      this.expect('}');
      break;
    }

    if (tag) this.currentTagScope().set(tag, tyInt);
    return tyInt;
  }

  private structUnionDecl(kind: 'struct' | 'union'): Type {
    this.expect(kind);
    let tag: string | undefined;
    if (this.peek().kind === 'ident') {
      tag = this.peek().text;
      this.pos++;
    }

    if (!this.consume('{')) {
      if (!tag) this.error(`expected a ${kind} tag`);
      const found = this.findTag(tag);
      if (found) return found;
      const incomplete =
        kind === 'struct' ? structType([], 0, 1, tag) : unionType([], 0, 1, tag);
      this.currentTagScope().set(tag, incomplete);
      return incomplete;
    }

    const members: Member[] = [];
    let offset = 0;
    let maxAlign = 1;
    let maxSize = 0;
    while (!this.consume('}')) {
      const spec = this.declspec();
      do {
        const { ty, name } = this.declarator(spec.ty);
        const alignTo = Math.min(4, ty.align);
        maxAlign = Math.max(maxAlign, alignTo);
        if (kind === 'struct') {
          offset = align(offset, alignTo);
          members.push({ name, ty, offset });
          offset += Math.max(1, ty.size);
        } else {
          members.push({ name, ty, offset: 0 });
          maxSize = Math.max(maxSize, Math.max(1, ty.size));
        }
      } while (this.consume(','));
      this.expect(';');
    }

    const size = kind === 'struct' ? align(offset, maxAlign) : align(maxSize, maxAlign);
    const ty =
      kind === 'struct'
        ? structType(members, size, maxAlign, tag)
        : unionType(members, size, maxAlign, tag);
    if (tag) {
      const existing = this.findTag(tag);
      if (existing && existing.size === 0 && existing.members?.length === 0) {
        Object.assign(existing, ty);
        return existing;
      }
      this.currentTagScope().set(tag, ty);
    }
    return ty;
  }

  // declarator = "*"* ident type-suffix
  private declarator(base: Type): { ty: Type; name: string } {
    let ty = base;
    while (this.consume('*')) ty = pointerTo(ty);
    if (this.consume('(')) {
      if (this.consume('*')) {
        const name = this.expectIdent();
        this.expect(')');
        if (this.equal('(')) {
          const fn = this.funcParams(base);
          return { ty: pointerTo(fn), name };
        }
        return { ty: this.typeSuffix(pointerTo(base)), name };
      }
      this.error('unsupported parenthesized declarator');
    }
    const name = this.expectIdent();
    ty = this.typeSuffix(ty);
    return { ty, name };
  }

  // type-name = declspec abstract-declarator
  private typeName(): Type {
    const spec = this.declspec();
    return this.abstractDeclarator(spec.ty);
  }

  private abstractDeclarator(base: Type): Type {
    let ty = base;
    while (this.consume('*')) ty = pointerTo(ty);
    return this.abstractTypeSuffix(ty);
  }

  private abstractTypeSuffix(base: Type): Type {
    if (this.consume('[')) {
      const len = this.peek().value;
      if (this.peek().kind !== 'num') this.error('expected an array length');
      this.pos++;
      this.expect(']');
      return arrayOf(this.abstractTypeSuffix(base), len);
    }
    return base;
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
        const { ty, name } = this.paramDeclarator(spec.ty);
        // Arrays and functions decay to pointers in a parameter list.
        const pty = ty.kind === 'array' ? pointerTo(elementType(ty)) : ty;
        params.push(pty);
        this.pendingParams.push({ ty: pty, name });
      } while (this.consume(','));
    }
    this.expect(')');
    return funcType(returnType, params);
  }

  private paramDeclarator(base: Type): { ty: Type; name?: string } {
    if (this.equal(',') || this.equal(')')) return { ty: base };
    return this.declarator(base);
  }

  private pendingParams: { ty: Type; name?: string }[] = [];

  // top-level = function-definition | global-declaration
  private topLevel(): void {
    const spec = this.declspec();
    if (this.consume(';')) return;
    const { ty, name } = this.declarator(spec.ty);

    if (spec.isTypedef) {
      this.currentTypedefScope().set(name, ty);
      while (this.consume(',')) {
        const next = this.declarator(spec.ty);
        this.currentTypedefScope().set(next.name, next.ty);
      }
      this.expect(';');
      return;
    }

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
    params: { ty: Type; name?: string }[],
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
    this.scopes = [new Map(), new Map()];
    this.typedefScopes = [this.typedefScopes[0]!, new Map()];
    this.enumScopes = [this.enumScopes[0]!, new Map()];
    this.tagScopes = [this.tagScopes[0]!, new Map()];
    for (const p of params) {
      if (!p.name) this.error(`function parameter name omitted in definition of '${name}'`);
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
    this.scopes = [new Map()];
    this.typedefScopes = [this.typedefScopes[0]!];
    this.enumScopes = [this.enumScopes[0]!];
    this.tagScopes = [this.tagScopes[0]!];
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
    const size = Math.max(1, ty.size);
    const bytes = new Uint8Array(size);
    this.writeInitializer(bytes, 0, ty);
    return bytes;
  }

  private localInitializer(obj: Obj): Node[] {
    const base: Node = { kind: 'var', line: this.peek().line, variable: obj };
    const out: Node[] = [];
    this.localInitializerInto(base, obj.ty, out);
    return out.map((lhs) => ({ kind: 'exprstmt', line: lhs.line, lhs }));
  }

  private localInitializerInto(lhs: Node, ty: Type, out: Node[]): void {
    if (this.consume('{')) {
      if (ty.kind === 'array') {
        const len = ty.arrayLen ?? 0;
        for (let i = 0; i < len && !this.equal('}'); i++) {
          const elem = this.arrayElement(lhs, i);
          this.localInitializerInto(elem, elementType(ty), out);
          this.consume(',');
        }
        while (!this.equal('}')) {
          this.assign();
          this.consume(',');
        }
      } else if (ty.kind === 'struct') {
        for (const member of ty.members ?? []) {
          if (this.equal('}')) break;
          const elem: Node = { kind: 'member', line: lhs.line, lhs, member };
          this.localInitializerInto(elem, member.ty, out);
          this.consume(',');
        }
        while (!this.equal('}')) {
          this.assign();
          this.consume(',');
        }
      } else if (ty.kind === 'union') {
        const member = ty.members?.[0];
        if (member && !this.equal('}')) {
          this.localInitializerInto({ kind: 'member', line: lhs.line, lhs, member }, member.ty, out);
          this.consume(',');
        }
        while (!this.equal('}')) {
          this.assign();
          this.consume(',');
        }
      } else if (!this.equal('}')) {
        out.push({ kind: 'assign', line: lhs.line, lhs, rhs: this.assign() });
        this.consume(',');
      }
      this.expect('}');
      return;
    }

    if (ty.kind === 'array' && elementType(ty).kind === 'char' && this.peek().kind === 'str') {
      const str = this.peek().str;
      this.pos++;
      const n = Math.min(str.length, ty.arrayLen ?? 0);
      for (let i = 0; i < n; i++) {
        out.push({
          kind: 'assign',
          line: lhs.line,
          lhs: this.arrayElement(lhs, i),
          rhs: { kind: 'num', line: lhs.line, value: str[i]! },
        });
      }
      return;
    }

    out.push({ kind: 'assign', line: lhs.line, lhs, rhs: this.assign() });
  }

  private writeInitializer(bytes: Uint8Array, off: number, ty: Type): void {
    if (this.consume('{')) {
      if (ty.kind === 'array') {
        const len = ty.arrayLen ?? 0;
        const elem = elementType(ty);
        for (let i = 0; i < len && !this.equal('}'); i++) {
          this.writeInitializer(bytes, off + i * elem.size, elem);
          this.consume(',');
        }
        while (!this.equal('}')) {
          this.assign();
          this.consume(',');
        }
      } else if (ty.kind === 'struct') {
        for (const member of ty.members ?? []) {
          if (this.equal('}')) break;
          this.writeInitializer(bytes, off + member.offset, member.ty);
          this.consume(',');
        }
        while (!this.equal('}')) {
          this.assign();
          this.consume(',');
        }
      } else if (ty.kind === 'union') {
        const member = ty.members?.[0];
        if (member && !this.equal('}')) {
          this.writeInitializer(bytes, off + member.offset, member.ty);
          this.consume(',');
        }
        while (!this.equal('}')) {
          this.assign();
          this.consume(',');
        }
      } else if (!this.equal('}')) {
        this.writeScalar(bytes, off, ty, this.evalConst(this.assign()));
        this.consume(',');
      }
      this.expect('}');
      return;
    }

    if (ty.kind === 'array' && elementType(ty).kind === 'char' && this.peek().kind === 'str') {
      const str = this.peek().str;
      this.pos++;
      bytes.set(str.slice(0, Math.min(str.length, ty.size)), off);
      return;
    }

    this.writeScalar(bytes, off, ty, this.evalConst(this.assign()));
  }

  private writeScalar(bytes: Uint8Array, off: number, ty: Type, value: number): void {
    const n = Math.min(Math.max(1, ty.size), 4);
    let v = value >>> 0;
    for (let i = 0; i < n; i++) {
      bytes[off + i] = v & 0xff;
      v >>>= 8;
    }
  }

  private arrayElement(base: Node, index: number): Node {
    return {
      kind: 'deref',
      line: base.line,
      lhs: this.newAdd(base, { kind: 'num', line: base.line, value: index }, base.line),
    };
  }

  // --- statements ----------------------------------------------------------

  private compoundStmt(): Node {
    const body: Node[] = [];
    this.enterScope();
    while (!this.consume('}')) {
      if (this.isEof()) this.error("expected '}'");
      if (this.isTypeName()) body.push(this.declaration());
      else body.push(this.stmt());
    }
    this.leaveScope();
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
      if (spec.isTypedef) {
        this.currentTypedefScope().set(name, ty);
        continue;
      }
      if (ty.kind === 'void') this.error(`variable '${name}' declared void`);
      if (spec.isStatic) {
        const obj = this.newStaticLocal(name, ty);
        if (this.consume('=')) obj.initData = this.globalInitializer(ty);
        continue;
      }
      const obj = this.newLocal(name, ty);
      if (this.consume('=')) {
        body.push(...this.localInitializer(obj));
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
      this.enterScope();
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
      this.leaveScope();
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
    if (this.consume('(')) {
      if (this.isTypeName()) {
        const ty = this.typeName();
        this.expect(')');
        return { kind: 'cast', line, lhs: this.unary(), castType: ty };
      }
      this.pos--;
    }
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
      if (this.consume('.')) {
        node = this.structRef(node, this.expectIdent(), line);
        continue;
      }
      if (this.consume('->')) {
        node = this.structRef({ kind: 'deref', line, lhs: node }, this.expectIdent(), line);
        continue;
      }
      if (this.equal('(')) {
        node = this.callExpr(node, line);
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
      if (this.consume('(')) {
        if (this.isTypeName()) {
          const ty = this.typeName();
          this.expect(')');
          return { kind: 'num', line: t.line, value: ty.size };
        }
        const operand = this.expr();
        this.expect(')');
        addType(operand);
        return { kind: 'num', line: t.line, value: operand.ty?.size ?? 4 };
      }
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
      const enumValue = this.findEnum(t.text);
      if (enumValue !== undefined && !this.findLocal(t.text) && !this.globals.has(t.text)) {
        return { kind: 'num', line: t.line, value: enumValue };
      }
      const obj = this.resolve(t.text);
      return { kind: 'var', line: t.line, variable: obj };
    }

    this.error(`unexpected token '${t.text}'`);
  }

  private structRef(lhs: Node, name: string, line: number): Node {
    addType(lhs);
    const ty = lhs.ty;
    if (!ty || (ty.kind !== 'struct' && ty.kind !== 'union')) {
      this.error(`member access on a non-aggregate`);
    }
    const member = ty.members?.find((m) => m.name === name);
    if (!member) this.error(`no member named '${name}'`);
    return { kind: 'member', line, lhs, member };
  }

  private funcall(name: string, line: number): Node {
    const args = this.callArgs();

    // `__`-prefixed names are target intrinsics handled by the backend, not real
    // calls. They need no declaration.
    if (name.startsWith('__')) {
      return { kind: 'funcall', line, builtin: name, args, funcReturn: tyInt };
    }

    const fn = this.globals.get(name);
    if (fn && !fn.isFunction) {
      const target: Node = { kind: 'var', line, variable: fn };
      addType(target);
      return this.indirectCall(target, args, line);
    }
    const local = this.findLocal(name);
    if (local) {
      const target: Node = { kind: 'var', line, variable: local };
      addType(target);
      return this.indirectCall(target, args, line);
    }
    const funcReturn = fn?.isFunction ? (fn.ty.returnType ?? tyInt) : tyInt;
    return { kind: 'funcall', line, funcName: name, args, funcReturn };
  }

  private callExpr(target: Node, line: number): Node {
    return this.indirectCall(target, this.callArgs(), line);
  }

  private callArgs(): Node[] {
    this.expect('(');
    const args: Node[] = [];
    if (!this.equal(')')) {
      do {
        args.push(this.assign());
      } while (this.consume(','));
    }
    this.expect(')');
    return args;
  }

  private indirectCall(target: Node, args: Node[], line: number): Node {
    addType(target);
    const targetTy = target.ty;
    const fnTy =
      targetTy?.kind === 'ptr' && targetTy.base?.kind === 'func'
        ? targetTy.base
        : targetTy?.kind === 'func'
          ? targetTy
          : undefined;
    return {
      kind: 'funcall',
      line,
      funcExpr: target,
      args,
      funcReturn: fnTy?.returnType ?? tyInt,
    };
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

  private enterScope(): void {
    this.scopes.push(new Map());
    this.typedefScopes.push(new Map());
    this.enumScopes.push(new Map());
    this.tagScopes.push(new Map());
  }

  private leaveScope(): void {
    this.scopes.pop();
    this.typedefScopes.pop();
    this.enumScopes.pop();
    this.tagScopes.pop();
  }

  private currentScope(): Map<string, Obj> {
    return this.scopes[this.scopes.length - 1]!;
  }

  private currentTypedefScope(): Map<string, Type> {
    return this.typedefScopes[this.typedefScopes.length - 1]!;
  }

  private currentEnumScope(): Map<string, number> {
    return this.enumScopes[this.enumScopes.length - 1]!;
  }

  private currentTagScope(): Map<string, Type> {
    return this.tagScopes[this.tagScopes.length - 1]!;
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

  private newStaticLocal(sourceName: string, ty: Type): Obj {
    const fnName = this.currentFn?.name ?? 'file';
    const obj: Obj = {
      name: `.L.static.${fnName}.${sourceName}.${this.staticCount++}`,
      ty,
      isLocal: false,
      isFunction: false,
      isStatic: true,
    };
    this.objects.push(obj);
    this.currentScope().set(sourceName, obj);
    return obj;
  }

  private resolve(name: string): Obj {
    const local = this.findLocal(name);
    if (local) return local;
    const global = this.globals.get(name);
    if (global) return global;
    this.error(`undefined variable '${name}'`);
  }

  private findLocal(name: string): Obj | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i]!.get(name);
      if (found) return found;
    }
    return undefined;
  }

  private findTypedef(name: string): Type | undefined {
    for (let i = this.typedefScopes.length - 1; i >= 0; i--) {
      const found = this.typedefScopes[i]!.get(name);
      if (found) return found;
    }
    return undefined;
  }

  private findEnum(name: string): number | undefined {
    for (let i = this.enumScopes.length - 1; i >= 0; i--) {
      const found = this.enumScopes[i]!.get(name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private findTag(name: string): Type | undefined {
    for (let i = this.tagScopes.length - 1; i >= 0; i--) {
      const found = this.tagScopes[i]!.get(name);
      if (found) return found;
    }
    return undefined;
  }

  private evalConst(node: Node): number {
    switch (node.kind) {
      case 'num':
        return node.value ?? 0;
      case 'neg':
        return -this.evalConst(node.lhs!) | 0;
      case 'not':
        return this.evalConst(node.lhs!) === 0 ? 1 : 0;
      case 'add':
        return (this.evalConst(node.lhs!) + this.evalConst(node.rhs!)) | 0;
      case 'sub':
        return (this.evalConst(node.lhs!) - this.evalConst(node.rhs!)) | 0;
      case 'mul':
        return Math.imul(this.evalConst(node.lhs!), this.evalConst(node.rhs!));
      case 'div':
        return (this.evalConst(node.lhs!) / this.evalConst(node.rhs!)) | 0;
      case 'mod':
        return this.evalConst(node.lhs!) % this.evalConst(node.rhs!);
      case 'shl':
        return this.evalConst(node.lhs!) << this.evalConst(node.rhs!);
      case 'shr':
        return this.evalConst(node.lhs!) >> this.evalConst(node.rhs!);
      case 'bitand':
        return this.evalConst(node.lhs!) & this.evalConst(node.rhs!);
      case 'bitor':
        return this.evalConst(node.lhs!) | this.evalConst(node.rhs!);
      case 'bitxor':
        return this.evalConst(node.lhs!) ^ this.evalConst(node.rhs!);
      case 'eq':
        return this.evalConst(node.lhs!) === this.evalConst(node.rhs!) ? 1 : 0;
      case 'ne':
        return this.evalConst(node.lhs!) !== this.evalConst(node.rhs!) ? 1 : 0;
      case 'lt':
        return this.evalConst(node.lhs!) < this.evalConst(node.rhs!) ? 1 : 0;
      case 'le':
        return this.evalConst(node.lhs!) <= this.evalConst(node.rhs!) ? 1 : 0;
      default:
        this.error('initializer is not a constant expression');
    }
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
