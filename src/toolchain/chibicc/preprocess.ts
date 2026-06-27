// Minimal C preprocessor for the chibicc-derived custom32 frontend.
//
// chibicc's `preprocess.c` is a full macro/conditional engine. This Phase 32
// slice supports object-like `#define`/`#undef` plus conditional compilation
// (`#if`/`#ifdef`/`#ifndef`/`#elif`/`#else`/`#endif`) for single translation
// units. Directive lines are stripped but replaced by blank lines so token line
// numbers still match the source.

import { type Token, tokenize } from './tokenize.ts';

export class PreprocessError extends Error {
  constructor(message: string, line: number) {
    super(`preprocess error (line ${line}): ${message}`);
  }
}

type MacroTable = Map<string, Token[]>;

interface ScanResult {
  text: string;
  macros: MacroTable;
}

interface ConditionalFrame {
  parentActive: boolean;
  active: boolean;
  everTaken: boolean;
  seenElse: boolean;
}

function truthy(value: number): boolean {
  return (value | 0) !== 0;
}

function evalIfExpression(source: string, macros: MacroTable, line: number): number {
  const normalized = source.replace(/\bdefined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))/g, (
    _m,
    parenName: string | undefined,
    bareName: string | undefined,
  ) => (macros.has(parenName ?? bareName ?? '') ? '1' : '0'));
  const raw = tokenize(normalized);
  const expanded = expand(raw, macros);
  let pos = 0;

  const peek = (): Token => expanded[Math.min(pos, expanded.length - 1)]!;
  const consume = (text: string): boolean => {
    const t = peek();
    if ((t.kind === 'punct' || t.kind === 'keyword') && t.text === text) {
      pos++;
      return true;
    }
    return false;
  };

  const primary = (): number => {
    if (consume('(')) {
      const v = logor();
      if (!consume(')')) throw new PreprocessError("expected ')' in #if expression", line);
      return v;
    }
    const t = peek();
    pos++;
    if (t.kind === 'num') return t.value | 0;
    if (t.kind === 'ident') return 0;
    throw new PreprocessError(`unexpected token '${t.text}' in #if expression`, line);
  };

  const unary = (): number => {
    if (consume('!')) return truthy(unary()) ? 0 : 1;
    if (consume('-')) return -unary() | 0;
    if (consume('+')) return unary();
    return primary();
  };

  const mul = (): number => {
    let v = unary();
    for (;;) {
      if (consume('*')) v = Math.imul(v, unary());
      else if (consume('/')) v = (v / unary()) | 0;
      else if (consume('%')) v %= unary();
      else return v | 0;
    }
  };

  const add = (): number => {
    let v = mul();
    for (;;) {
      if (consume('+')) v = (v + mul()) | 0;
      else if (consume('-')) v = (v - mul()) | 0;
      else return v | 0;
    }
  };

  const relational = (): number => {
    let v = add();
    for (;;) {
      if (consume('<')) v = v < add() ? 1 : 0;
      else if (consume('<=')) v = v <= add() ? 1 : 0;
      else if (consume('>')) v = v > add() ? 1 : 0;
      else if (consume('>=')) v = v >= add() ? 1 : 0;
      else return v | 0;
    }
  };

  const equality = (): number => {
    let v = relational();
    for (;;) {
      if (consume('==')) v = v === relational() ? 1 : 0;
      else if (consume('!=')) v = v !== relational() ? 1 : 0;
      else return v | 0;
    }
  };

  const logand = (): number => {
    let v = equality();
    while (consume('&&')) v = truthy(v) && truthy(equality()) ? 1 : 0;
    return v | 0;
  };

  const logor = (): number => {
    let v = logand();
    while (consume('||')) v = truthy(v) || truthy(logand()) ? 1 : 0;
    return v | 0;
  };

  const result = logor();
  if (peek().kind !== 'eof') {
    throw new PreprocessError(`trailing token '${peek().text}' in #if expression`, line);
  }
  return result;
}

// Pull `#define`/`#undef` out of the source line by line, leaving blank lines in
// their place. Conditional directives keep inactive source out of the token
// stream while preserving line numbering.
function scanDirectives(source: string): ScanResult {
  const macros: MacroTable = new Map();
  const lines = source.split('\n');
  const out: string[] = [];
  const conds: ConditionalFrame[] = [];

  const isActive = (): boolean => conds.every((c) => c.active);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('#')) {
      out.push(isActive() ? line : '');
      continue;
    }
    out.push(''); // preserve line numbering

    const body = trimmed.slice(1).trim();
    const space = body.search(/\s/);
    const directive = space === -1 ? body : body.slice(0, space);
    const rest = space === -1 ? '' : body.slice(space).trim();

    if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
      const parentActive = isActive();
      let cond: boolean;
      if (directive === 'if') {
        cond = truthy(evalIfExpression(rest, macros, i + 1));
      } else {
        const m = /^([A-Za-z_]\w*)$/.exec(rest);
        if (!m) throw new PreprocessError(`malformed #${directive}`, i + 1);
        cond = macros.has(m[1]!);
        if (directive === 'ifndef') cond = !cond;
      }
      const active = parentActive && cond;
      conds.push({ parentActive, active, everTaken: active, seenElse: false });
      continue;
    }

    if (directive === 'elif') {
      const frame = conds.at(-1);
      if (!frame) throw new PreprocessError('#elif without #if', i + 1);
      if (frame.seenElse) throw new PreprocessError('#elif after #else', i + 1);
      if (!frame.parentActive || frame.everTaken) {
        frame.active = false;
      } else {
        frame.active = truthy(evalIfExpression(rest, macros, i + 1));
        frame.everTaken = frame.active;
      }
      continue;
    }

    if (directive === 'else') {
      const frame = conds.at(-1);
      if (!frame) throw new PreprocessError('#else without #if', i + 1);
      if (frame.seenElse) throw new PreprocessError('duplicate #else', i + 1);
      frame.seenElse = true;
      frame.active = frame.parentActive && !frame.everTaken;
      frame.everTaken = true;
      continue;
    }

    if (directive === 'endif') {
      if (!conds.pop()) throw new PreprocessError('#endif without #if', i + 1);
      continue;
    }

    if (!isActive()) continue;

    if (directive === 'define') {
      const m = /^([A-Za-z_]\w*)/.exec(rest);
      if (!m) throw new PreprocessError('malformed #define', i + 1);
      const name = m[1]!;
      if (rest[m[0].length] === '(') {
        throw new PreprocessError('function-like macros are not supported yet', i + 1);
      }
      const replacement = rest.slice(m[0].length).trim();
      const toks = tokenize(replacement).filter((t) => t.kind !== 'eof');
      macros.set(name, toks);
    } else if (directive === 'undef') {
      const m = /^([A-Za-z_]\w*)/.exec(rest);
      if (m) macros.delete(m[1]!);
    }
    // Includes and unsupported directives are intentionally ignored in this
    // single-translation-unit slice once conditionals have selected the source.
  }

  if (conds.length > 0) throw new PreprocessError('unterminated conditional directive', lines.length);
  return { text: out.join('\n'), macros };
}

// Substitute object-like macros in the token stream. A bounded expansion depth
// guards against self-referential macros without a full hide-set.
function expand(tokens: Token[], macros: MacroTable): Token[] {
  if (macros.size === 0) return tokens;
  let work = tokens;
  for (let pass = 0; pass < 16; pass++) {
    let changed = false;
    const next: Token[] = [];
    for (const tok of work) {
      const replacement = tok.kind === 'ident' ? macros.get(tok.text) : undefined;
      if (replacement) {
        for (const r of replacement) next.push({ ...r, line: tok.line });
        changed = true;
      } else {
        next.push(tok);
      }
    }
    work = next;
    if (!changed) break;
  }
  return work;
}

// Run the preprocessor: directive extraction, tokenization, macro expansion.
export function preprocess(source: string): Token[] {
  const { text, macros } = scanDirectives(source);
  return expand(tokenize(text), macros);
}
