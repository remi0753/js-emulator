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
  is64,
  isAggregate,
  isFloating,
  isInteger,
  isPointerLike,
  type Member,
  pointerTo,
  structType,
  type Type,
  tyChar,
  tyDouble,
  tyFloat,
  tyInt,
  tyLLong,
  tyLong,
  tyShort,
  tyUChar,
  tyUInt,
  tyULLong,
  tyULong,
  tyUShort,
  tyVoid,
  unionType,
  vlaOf,
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
  | 'do'
  | 'switch'
  | 'block'
  | 'exprstmt'
  | 'break'
  | 'continue'
  | 'member'
  | 'cast'
  | 'compoundlit'
  | 'vlaalloc'
  | 'vastart'
  | 'vaarg';

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
  valueHi?: number; // high word for 64-bit numeric literals
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
  initStmts?: Node[];
  vlaLen?: Node;
  vlaSizeObj?: Obj;
  vaList?: Node;
  vaParam?: Obj;
  // Switch cases.
  cases?: { value: number; body: Node }[];
  defaultCase?: Node;
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
  // Symbol relocations applied over initData (pointer/address initializers):
  // each writes `&symbol + addend` into the 4 bytes at `offset`.
  initRelocs?: GReloc[];
  isString?: boolean; // anonymous string-literal storage
  // Function.
  hasBody?: boolean;
  params?: Obj[];
  locals?: Obj[];
  bodyNode?: Node;
  stackSize?: number;
  returnBufferOffset?: number;
  vlaSizeObj?: Obj;
}

export interface Program {
  // Globals, string literals, and functions in definition order.
  objects: Obj[];
}

// A relocation applied to a global's initializer bytes.
export interface GReloc {
  offset: number;
  symbol: string;
  addend: number;
}

// chibicc's Initializer tree: aggregates carry one child Init per element or
// member, scalars carry the initializing expression. Absent children stay
// expr-less and lower to zero (aggregate zero-fill).
interface Init {
  ty: Type;
  expr: Node | null;
  children: Init[] | null;
  // For unions, the index of the member selected by the initializer.
  unionActive?: number;
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

// Target intrinsics handled directly by the backend (codegen `genBuiltin`).
const INTRINSICS = new Set(['__syscall', '__out', '__in', '__halt']);

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
  private anonCount = 0;
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
      'float',
      'double',
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
    let longCount = 0;
    let hasInt = false;
    let hasVoid = false;
    let hasFloat = false;
    let hasDouble = false;
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
        longCount++;
        this.pos++;
        count++;
        continue;
      }
      if (word === 'float') {
        hasFloat = true;
        this.pos++;
        count++;
        continue;
      }
      if (word === 'double') {
        hasDouble = true;
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
    else if (hasFloat) ty = tyFloat;
    else if (hasDouble) ty = tyDouble;
    else if (hasChar) ty = isUnsigned ? tyUChar : tyChar;
    else if (hasShort) ty = isUnsigned ? tyUShort : tyShort;
    else if (longCount >= 2) ty = isUnsigned ? tyULLong : tyLLong;
    else if (longCount === 1) ty = isUnsigned ? tyULong : tyLong;
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
      const incomplete = kind === 'struct' ? structType([], 0, 1, tag) : unionType([], 0, 1, tag);
      this.currentTagScope().set(tag, incomplete);
      return incomplete;
    }

    const members: Member[] = [];
    let offset = 0;
    let maxAlign = 1;
    let maxSize = 0;
    let bitUnit = 0;
    let bitCursor = 0;
    while (!this.consume('}')) {
      const spec = this.declspec();
      do {
        const { ty, name } = this.declarator(spec.ty);
        if (this.consume(':')) {
          const width = this.evalConst(this.assign());
          if (width < 0 || width > 32) this.error('invalid bit-field width');
          maxAlign = Math.max(maxAlign, 4);
          if (kind === 'union') {
            if (width > 0 && name)
              members.push({ name, ty, offset: 0, bitOffset: 0, bitWidth: width });
            maxSize = Math.max(maxSize, 4);
            continue;
          }
          if (width === 0) {
            offset = align(offset, 4);
            if (bitCursor > 0) offset = bitUnit + 4;
            bitCursor = 0;
            continue;
          }
          if (bitCursor === 0) {
            offset = align(offset, 4);
            bitUnit = offset;
          } else if (bitCursor + width > 32) {
            offset = bitUnit + 4;
            offset = align(offset, 4);
            bitUnit = offset;
            bitCursor = 0;
          }
          if (name)
            members.push({ name, ty, offset: bitUnit, bitOffset: bitCursor, bitWidth: width });
          bitCursor += width;
          offset = Math.max(offset, bitUnit + 4);
          continue;
        }
        if (kind === 'struct' && bitCursor > 0) {
          offset = bitUnit + 4;
          bitCursor = 0;
        }
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

  // declarator = "*"* ("(" declarator ")" | ident?) type-suffix
  //
  // A faithful port of chibicc's recursive declarator: when a parenthesized
  // declarator appears, parse the inner declarator twice. The first (dummy)
  // pass skips ahead so the outer type-suffix can be applied to `ty`; the
  // second pass re-parses the inner declarator against that completed type.
  // This handles nested function pointers, pointer-to-array, function-returning-
  // pointer, and abstract (name-less) declarators uniformly.
  private declarator(base: Type): { ty: Type; name: string } {
    let ty = base;
    while (this.consume('*')) ty = pointerTo(ty);

    if (this.equal('(') && this.isParenDeclarator()) {
      const start = this.pos;
      this.pos++; // '('
      this.declarator(tyVoid); // dummy pass: advance past the inner declarator
      this.expect(')');
      ty = this.typeSuffix(ty);
      const afterSuffix = this.pos;
      this.pos = start + 1;
      const inner = this.declarator(ty);
      this.expect(')');
      this.pos = afterSuffix;
      return inner;
    }

    let name = '';
    if (this.peek().kind === 'ident') name = this.expectIdent();
    ty = this.typeSuffix(ty);
    return { ty, name };
  }

  // Positioned at "(", decide whether it opens a nested declarator (e.g.
  // "int (*p)") or a function parameter list (e.g. the abstract type "int(int)").
  private isParenDeclarator(): boolean {
    const next = this.peek(1);
    if (next.text === ')') return false; // "()" → function suffix
    if (next.text === '*' || next.text === '(' || next.text === '[') return true;
    // A typedef name after "(" is a parameter type; any other identifier names
    // the declared object.
    if (next.kind === 'ident') return this.findTypedef(next.text) === undefined;
    return false; // a type keyword → parameter list
  }

  // type-name = declspec abstract-declarator
  private typeName(): Type {
    const spec = this.declspec();
    return this.abstractDeclarator(spec.ty);
  }

  // An abstract declarator is just a declarator that need not bind a name.
  private abstractDeclarator(base: Type): Type {
    return this.declarator(base).ty;
  }

  // type-suffix = "(" func-params ")" | "[" num "]" type-suffix | ε
  private typeSuffix(base: Type): Type {
    if (this.equal('(')) return this.funcParams(base);
    if (this.consume('[')) {
      let len: number | undefined;
      let vlaLen: Node | undefined;
      if (this.peek().kind === 'num') {
        len = this.peek().value;
        this.pos++;
      } else {
        if (!this.currentFn) this.error('variably modified file-scope array');
        vlaLen = this.assign();
      }
      this.expect(']');
      const elem = this.typeSuffix(base);
      return vlaLen ? vlaOf(elem, vlaLen) : arrayOf(elem, len ?? 0);
    }
    return base;
  }

  // func-params = "(" ("void" | param ("," param)*)? ")"
  // Returns a function type; parameter Objs are materialized later in funcDef.
  private funcParams(returnType: Type): Type {
    this.expect('(');
    const params: Type[] = [];
    let isVariadic = false;
    this.pendingParams = [];
    if (this.equal('void') && this.peek(1).text === ')') {
      this.pos++;
    } else if (!this.equal(')')) {
      do {
        if (this.consume('...')) {
          isVariadic = true;
          break;
        }
        const spec = this.declspec();
        const { ty, name } = this.paramDeclarator(spec.ty);
        // Arrays and functions decay to pointers in a parameter list.
        const pty = ty.kind === 'array' ? pointerTo(elementType(ty)) : ty;
        params.push(pty);
        this.pendingParams.push({ ty: pty, name });
      } while (this.consume(','));
    }
    this.expect(')');
    return funcType(returnType, params, isVariadic);
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
      const init = this.globalInitializer(ty);
      obj.initData = init.data;
      if (init.relocs.length > 0) obj.initRelocs = init.relocs;
    }
    this.globals.set(name, obj);
    this.objects.push(obj);
  }

  // Constant initializer for a global: build the Init tree, then lower it to
  // bytes plus symbol relocations (for pointer/address initializers).
  private globalInitializer(ty: Type): { data: Uint8Array; relocs: GReloc[] } {
    const init = this.initializer(ty);
    const data = new Uint8Array(Math.max(1, ty.size));
    const relocs: GReloc[] = [];
    this.writeGlobalInit(data, relocs, 0, init);
    return { data, relocs };
  }

  private localInitializer(obj: Obj): Node[] {
    const init = this.initializer(obj.ty);
    const base: Node = { kind: 'var', line: this.peek().line, variable: obj };
    const out: Node[] = [];
    this.lowerLocalInit(base, init, out);
    return out.map((lhs) => ({ kind: 'exprstmt', line: lhs.line, lhs }));
  }

  // --- initializer tree (chibicc's Initializer) ----------------------------

  // Parse an initializer for `ty` into an Init tree. Aggregates allocate a child
  // Init per element/member; absent children stay expr-less and lower to zero.
  private initializer(ty: Type): Init {
    const init = this.newInit(ty);
    this.initializer2(init);
    return init;
  }

  private newInit(ty: Type): Init {
    if (ty.kind === 'array') {
      const elem = elementType(ty);
      const len = ty.arrayLen ?? 0;
      return { ty, expr: null, children: Array.from({ length: len }, () => this.newInit(elem)) };
    }
    if (ty.kind === 'struct' || ty.kind === 'union') {
      return { ty, expr: null, children: (ty.members ?? []).map((m) => this.newInit(m.ty)) };
    }
    return { ty, expr: null, children: null };
  }

  private initializer2(init: Init): void {
    const ty = init.ty;
    if (ty.kind === 'array' && elementType(ty).kind === 'char' && this.peek().kind === 'str') {
      this.stringInit(init);
      return;
    }
    if (this.equal('{')) {
      if (ty.kind === 'array') {
        this.arrayInit(init);
        return;
      }
      if (ty.kind === 'struct') {
        this.structInit(init);
        return;
      }
      if (ty.kind === 'union') {
        this.unionInit(init);
        return;
      }
      // A scalar wrapped in braces: `int x = { 5 };`.
      this.expect('{');
      if (!this.equal('}')) init.expr = this.assign();
      this.consume(',');
      this.expect('}');
      return;
    }
    init.expr = this.assign();
  }

  private stringInit(init: Init): void {
    const str = this.peek().str;
    const line = this.peek().line;
    this.pos++;
    const children = init.children ?? [];
    const n = Math.min(str.length, children.length);
    for (let i = 0; i < n; i++) {
      children[i]!.expr = { kind: 'num', line, value: str[i]! };
    }
  }

  private arrayInit(init: Init): void {
    this.expect('{');
    const children = init.children ?? [];
    for (let i = 0; !this.consumeEnd(); ) {
      if (i > 0) this.expect(',');
      if (this.equal('[')) {
        this.pos++;
        i = this.constIndex();
        this.expect(']');
        if (i < children.length) this.designationTail(children[i]!);
        else this.error('array designator out of range');
        i++;
        continue;
      }
      if (i < children.length) this.initializer2(children[i]!);
      else this.skipInitializer();
      i++;
    }
  }

  private structInit(init: Init): void {
    this.expect('{');
    const members = init.ty.members ?? [];
    const children = init.children ?? [];
    for (let mi = 0; !this.consumeEnd(); ) {
      if (mi > 0) this.expect(',');
      if (this.equal('.')) {
        this.pos++;
        const name = this.expectIdent();
        mi = members.findIndex((m) => m.name === name);
        if (mi < 0) this.error(`struct has no member '${name}'`);
        this.designationTail(children[mi]!);
        mi++;
        continue;
      }
      if (mi < members.length) this.initializer2(children[mi]!);
      else this.skipInitializer();
      mi++;
    }
  }

  private unionInit(init: Init): void {
    this.expect('{');
    const members = init.ty.members ?? [];
    const children = init.children ?? [];
    let active = 0;
    if (this.equal('.')) {
      this.pos++;
      const name = this.expectIdent();
      active = members.findIndex((m) => m.name === name);
      if (active < 0) this.error(`union has no member '${name}'`);
      this.designationTail(children[active]!);
    } else if (!this.equal('}') && children.length > 0) {
      this.initializer2(children[0]!);
    }
    init.unionActive = active;
    this.consume(',');
    this.expect('}');
  }

  // Parse the tail of a designator: further `[index]` / `.member` designators,
  // then `=` and the value, into `init`.
  private designationTail(init: Init): void {
    if (this.equal('[')) {
      this.pos++;
      const i = this.constIndex();
      this.expect(']');
      this.designationTail((init.children ?? [])[i]!);
      return;
    }
    if (this.equal('.')) {
      this.pos++;
      const name = this.expectIdent();
      const members = init.ty.members ?? [];
      const mi = members.findIndex((m) => m.name === name);
      if (mi < 0) this.error(`aggregate has no member '${name}'`);
      if (init.ty.kind === 'union') init.unionActive = mi;
      this.designationTail((init.children ?? [])[mi]!);
      return;
    }
    this.consume('=');
    this.initializer2(init);
  }

  // Consume the closing brace of an initializer list, allowing a trailing comma.
  private consumeEnd(): boolean {
    if (this.consume('}')) return true;
    if (this.equal(',') && this.peek(1).text === '}') {
      this.pos += 2;
      return true;
    }
    return false;
  }

  // Skip an excess initializer (more initializers than the aggregate has slots).
  private skipInitializer(): void {
    if (this.equal('{')) {
      this.pos++;
      let depth = 1;
      while (depth > 0 && !this.isEof()) {
        if (this.equal('{')) depth++;
        else if (this.equal('}')) depth--;
        this.pos++;
      }
      return;
    }
    this.assign();
  }

  private constIndex(): number {
    const v = this.evalConst(this.assign());
    if (v < 0) this.error('negative array designator');
    return v;
  }

  // Lower an Init tree to assignment statements for a local object, zero-filling
  // every leaf that has no initializing expression.
  private lowerLocalInit(lhs: Node, init: Init, out: Node[]): void {
    const ty = init.ty;
    if ((ty.kind === 'struct' || ty.kind === 'union') && init.expr) {
      out.push({ kind: 'assign', line: lhs.line, lhs, rhs: init.expr });
      return;
    }
    if (ty.kind === 'array') {
      const children = init.children ?? [];
      for (let i = 0; i < children.length; i++) {
        this.lowerLocalInit(this.arrayElement(lhs, i), children[i]!, out);
      }
      return;
    }
    if (ty.kind === 'struct') {
      const members = ty.members ?? [];
      const children = init.children ?? [];
      for (let mi = 0; mi < members.length; mi++) {
        const elem: Node = { kind: 'member', line: lhs.line, lhs, member: members[mi]! };
        this.lowerLocalInit(elem, children[mi]!, out);
      }
      return;
    }
    if (ty.kind === 'union') {
      const active = init.unionActive ?? 0;
      const member = ty.members?.[active];
      const child = (init.children ?? [])[active];
      if (member && child) {
        const elem: Node = { kind: 'member', line: lhs.line, lhs, member };
        this.lowerLocalInit(elem, child, out);
      }
      return;
    }
    const rhs: Node = init.expr ?? { kind: 'num', line: lhs.line, value: 0 };
    out.push({ kind: 'assign', line: lhs.line, lhs, rhs });
  }

  // Lower an Init tree to global initializer bytes plus symbol relocations.
  private writeGlobalInit(bytes: Uint8Array, relocs: GReloc[], off: number, init: Init): void {
    const ty = init.ty;
    if (ty.kind === 'array') {
      const elem = elementType(ty);
      const children = init.children ?? [];
      for (let i = 0; i < children.length; i++) {
        this.writeGlobalInit(bytes, relocs, off + i * elem.size, children[i]!);
      }
      return;
    }
    if (ty.kind === 'struct') {
      const members = ty.members ?? [];
      const children = init.children ?? [];
      for (let mi = 0; mi < members.length; mi++) {
        this.writeGlobalInit(bytes, relocs, off + (members[mi]!.offset ?? 0), children[mi]!);
      }
      return;
    }
    if (ty.kind === 'union') {
      const active = init.unionActive ?? 0;
      const member = ty.members?.[active];
      const child = (init.children ?? [])[active];
      if (member && child) this.writeGlobalInit(bytes, relocs, off + (member.offset ?? 0), child);
      return;
    }
    if (!init.expr) return; // zero-filled
    const c = this.evalConstReloc(init.expr);
    if (c.label) relocs.push({ offset: off, symbol: c.label, addend: c.value });
    else this.writeScalar(bytes, off, ty, c.value, c.valueHi);
  }

  private writeScalar(bytes: Uint8Array, off: number, ty: Type, value: number, valueHi = 0): void {
    const n = Math.min(Math.max(1, ty.size), 8);
    let v = value >>> 0;
    for (let i = 0; i < n; i++) {
      if (i === 4) v = valueHi >>> 0;
      bytes[off + i] = v & 0xff;
      v >>>= 8;
    }
  }

  // Evaluate a relocatable constant: a plain integer, or a label (symbol
  // address) plus an integer addend, for pointer/address initializers.
  private evalConstReloc(node: Node): { label?: string; value: number; valueHi?: number } {
    switch (node.kind) {
      case 'num':
        return { value: node.value ?? 0, valueHi: node.valueHi };
      case 'addr':
        return this.evalConstAddr(node.lhs!);
      case 'var': {
        const obj = node.variable!;
        // Arrays and functions decay to their address.
        if (obj.ty.kind === 'array' || obj.ty.kind === 'func') {
          if (obj.isLocal) this.error('initializer is not a constant expression');
          return { label: obj.name, value: 0 };
        }
        this.error('initializer is not a constant expression');
        break;
      }
      case 'cast':
        return this.evalConstReloc(node.lhs!);
      case 'add': {
        const l = this.evalConstReloc(node.lhs!);
        const r = this.evalConstReloc(node.rhs!);
        if (l.label && r.label) this.error('initializer is not a constant expression');
        return { label: l.label ?? r.label, value: (l.value + r.value) | 0 };
      }
      case 'sub': {
        const l = this.evalConstReloc(node.lhs!);
        const r = this.evalConstReloc(node.rhs!);
        if (r.label) this.error('initializer is not a constant expression');
        return { label: l.label, value: (l.value - r.value) | 0 };
      }
      default:
        return { value: this.evalConst(node) };
    }
  }

  // Evaluate the address of an lvalue as a label plus an integer addend.
  private evalConstAddr(node: Node): { label: string; value: number } {
    switch (node.kind) {
      case 'var': {
        const obj = node.variable!;
        if (obj.isLocal) this.error('initializer is not a constant expression');
        return { label: obj.name, value: 0 };
      }
      case 'member': {
        const base = this.evalConstAddr(node.lhs!);
        return { label: base.label, value: base.value + (node.member?.offset ?? 0) };
      }
      case 'deref': {
        const r = this.evalConstReloc(node.lhs!);
        if (!r.label) this.error('initializer is not a constant expression');
        return { label: r.label, value: r.value };
      }
      default:
        this.error('initializer is not a constant expression');
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
        if (this.consume('=')) {
          const init = this.globalInitializer(ty);
          obj.initData = init.data;
          if (init.relocs.length > 0) obj.initRelocs = init.relocs;
        }
        continue;
      }
      const obj = this.newLocal(name, ty);
      if (ty.kind === 'array' && ty.isVLA) {
        const sizeObj = this.newLocal(`${name}.sizeof`, tyInt);
        obj.vlaSizeObj = sizeObj;
        body.push({
          kind: 'vlaalloc',
          line: this.peek().line,
          variable: obj,
          vlaLen: ty.vlaLen,
          vlaSizeObj: sizeObj,
        });
        continue;
      }
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

    if (this.consume('do')) {
      const bodyStmt = this.stmt();
      this.expect('while');
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      this.expect(';');
      return { kind: 'do', line, cond, thenStmt: bodyStmt };
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

    if (this.consume('switch')) {
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      return this.switchStmt(line, cond);
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

  private switchStmt(line: number, cond: Node): Node {
    this.expect('{');
    const cases: { value: number; body: Node }[] = [];
    let defaultCase: Node | undefined;
    let current: { value?: number; stmts: Node[] } | undefined;

    const flush = (): void => {
      if (!current) return;
      const body: Node = { kind: 'block', line, body: current.stmts };
      if (current.value === undefined) defaultCase = body;
      else cases.push({ value: current.value, body });
    };

    while (!this.consume('}')) {
      if (this.consume('case')) {
        flush();
        const value = this.evalConst(this.expr());
        this.expect(':');
        current = { value, stmts: [] };
        continue;
      }
      if (this.consume('default')) {
        flush();
        this.expect(':');
        current = { stmts: [] };
        continue;
      }
      if (!current) this.error('expected case/default label in switch');
      if (this.isTypeName()) current.stmts.push(this.declaration());
      else current.stmts.push(this.stmt());
    }
    flush();

    return { kind: 'switch', line, cond, cases, defaultCase };
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
        if (this.equal('{')) return this.compoundLiteral(ty, line);
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
        if (operand.kind === 'var' && operand.variable?.vlaSizeObj) {
          return { kind: 'var', line: t.line, variable: operand.variable.vlaSizeObj };
        }
        return { kind: 'num', line: t.line, value: operand.ty?.size ?? 4 };
      }
      const operand = this.unary();
      addType(operand);
      if (operand.kind === 'var' && operand.variable?.vlaSizeObj) {
        return { kind: 'var', line: t.line, variable: operand.variable.vlaSizeObj };
      }
      return { kind: 'num', line: t.line, value: operand.ty?.size ?? 4 };
    }

    if (t.kind === 'num') {
      this.pos++;
      if (t.isFloatLit) {
        return { kind: 'num', line: t.line, value: t.value, ty: tyFloat };
      }
      if (t.isDoubleLit) {
        return { kind: 'num', line: t.line, value: t.value, valueHi: t.valueHi, ty: tyDouble };
      }
      // A `long long` literal carries its 64-bit type so addType keeps it 64-bit.
      if (t.is64Lit) {
        return {
          kind: 'num',
          line: t.line,
          value: t.value,
          ty: t.isUnsignedLit ? tyULLong : tyLLong,
        };
      }
      return { kind: 'num', line: t.line, value: t.value };
    }

    if (t.kind === 'str') {
      this.pos++;
      const obj = this.newStringLiteral(t.str);
      return { kind: 'var', line: t.line, variable: obj };
    }

    if (t.kind === 'ident') {
      this.pos++;
      if (t.text === '__builtin_va_start' && this.equal('(')) return this.vaStart(t.line);
      if (t.text === '__builtin_va_arg' && this.equal('(')) return this.vaArg(t.line);
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

  private vaStart(line: number): Node {
    this.expect('(');
    const ap = this.assign();
    this.expect(',');
    const name = this.expectIdent();
    this.expect(')');
    const obj = this.findLocal(name);
    if (!obj?.isParam) this.error('va_start second argument must be a parameter');
    return { kind: 'vastart', line, vaList: ap, vaParam: obj, ty: tyVoid };
  }

  private vaArg(line: number): Node {
    this.expect('(');
    const ap = this.assign();
    this.expect(',');
    const ty = this.typeName();
    this.expect(')');
    const node: Node = { kind: 'vaarg', line, vaList: ap, castType: ty, ty };
    if (isAggregate(ty) && this.currentFn) {
      node.variable = this.newLocal(`.vaarg.${this.anonCount++}`, ty);
    }
    return node;
  }

  private compoundLiteral(ty: Type, line: number): Node {
    if (this.currentFn) {
      const obj = this.newLocal(`.compound.${this.anonCount++}`, ty);
      return {
        kind: 'compoundlit',
        line,
        variable: obj,
        initStmts: this.localInitializer(obj),
      };
    }
    const obj: Obj = {
      name: `.L.compound.${this.anonCount++}`,
      ty,
      isLocal: false,
      isFunction: false,
      isStatic: true,
    };
    const init = this.globalInitializer(ty);
    obj.initData = init.data;
    if (init.relocs.length > 0) obj.initRelocs = init.relocs;
    this.objects.push(obj);
    return { kind: 'var', line, variable: obj };
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

    // Known target intrinsics are handled by the backend, not real calls, and
    // need no declaration. Other `__`-prefixed names (e.g. the `__i64_*` runtime
    // helpers) are ordinary functions.
    if (INTRINSICS.has(name)) {
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
    const converted = this.convertArgs(args, fn?.isFunction ? fn.ty.params : undefined);
    return this.funcallNode({ kind: 'funcall', line, funcName: name, args: converted, funcReturn });
  }

  private defaultArgPromotion(arg: Node): Node {
    addType(arg);
    if (arg.ty?.kind === 'float') {
      return { kind: 'cast', line: arg.line, lhs: arg, castType: tyDouble, ty: tyDouble };
    }
    return arg;
  }

  // Convert each argument to its parameter type where that changes the ABI slot
  // count or representation. Prototype-less calls and variadic excess arguments
  // use C's default argument promotions, including float -> double.
  private convertArgs(args: Node[], params?: Type[]): Node[] {
    if (!params) return args.map((arg) => this.defaultArgPromotion(arg));
    return args.map((arg, i) => {
      const pty = params[i];
      if (!pty) return this.defaultArgPromotion(arg); // excess / variadic argument
      addType(arg);
      if (is64(pty) === is64(arg.ty ?? tyInt) && pty.kind === arg.ty?.kind) return arg;
      return { kind: 'cast', line: arg.line, lhs: arg, castType: pty, ty: pty };
    });
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
    return this.funcallNode({
      kind: 'funcall',
      line,
      funcExpr: target,
      args: this.convertArgs(args, fnTy?.params),
      funcReturn: fnTy?.returnType ?? tyInt,
    });
  }

  private funcallNode(node: Node): Node {
    if (isAggregate(node.funcReturn) && this.currentFn) {
      node.variable = this.newLocal(`.retbuf.${this.anonCount++}`, node.funcReturn!);
    }
    return node;
  }

  // --- pointer-aware add/sub (chibicc new_add / new_sub) --------------------

  private newAdd(lhs: Node, rhs: Node, line: number): Node {
    addType(lhs);
    addType(rhs);
    const lt = lhs.ty!;
    const rt = rhs.ty!;
    if (isFloating(lt) || isFloating(rt)) {
      if (isPointerLike(lt) || isPointerLike(rt)) this.error('invalid operands to +');
      return { kind: 'add', line, lhs, rhs };
    }
    if (isInteger(lt) && isInteger(rt)) return { kind: 'add', line, lhs, rhs };
    if (isPointerLike(lt) && isPointerLike(rt)) this.error('invalid pointer + pointer');
    if (!isPointerLike(lt) && !isPointerLike(rt)) this.error('invalid operands to +');
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
    if (isFloating(lt) || isFloating(rt)) {
      if (isPointerLike(lt) || isPointerLike(rt)) this.error('invalid operands to -');
      return { kind: 'sub', line, lhs, rhs };
    }
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
    // Arguments are pushed right-to-left, so each fixed parameter's offset is
    // independent of any trailing variadic arguments. Each occupies a
    // 4-byte-rounded slot, low word first, so a `long long` parameter spans two
    // slots.
    const slot = (ty: Type): number => align(Math.max(1, ty.size), 4);
    const hiddenReturnBytes = isAggregate(fn.ty.returnType) ? 4 : 0;
    fn.returnBufferOffset = hiddenReturnBytes > 0 ? -hiddenReturnBytes : undefined;
    let acc = hiddenReturnBytes;
    for (const p of params) {
      acc += slot(p.ty);
      p.offset = -acc;
    }
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
