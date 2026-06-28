// Minimal C preprocessor for the chibicc-derived custom32 frontend.
//
// chibicc's `preprocess.c` is a full macro/conditional engine. This Phase 32
// slice supports object-like and function-like `#define`/`#undef` (including the
// `#` stringize and `##` paste operators), conditional compilation
// (`#if`/`#ifdef`/`#ifndef`/`#elif`/`#else`/`#endif`), and `#include` with
// `#pragma once` / `#ifndef` include guards. Directive lines are stripped but
// replaced by blank lines so token line numbers still match the source;
// included files are spliced in textually after their own directives run.

import { type Token, tokenize } from './tokenize.ts';

export class PreprocessError extends Error {
  constructor(message: string, line: number) {
    super(`preprocess error (line ${line}): ${message}`);
  }
}

// Resolve an `#include` spec to the file's source text. `isAngle` is true for
// `<...>` includes and false for `"..."`. Returning `undefined` means "not
// found"; the returned `path` identifies the file for `#pragma once`.
export type IncludeResolver = (
  name: string,
  isAngle: boolean,
) => { path: string; text: string } | undefined;

interface Macro {
  params?: string[];
  body: Token[];
}

type MacroTable = Map<string, Macro>;

interface ScanResult {
  text: string;
  macros: MacroTable;
}

const MAX_INCLUDE_DEPTH = 64;

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
  const normalized = source.replace(
    /\bdefined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))/g,
    (_m, parenName: string | undefined, bareName: string | undefined) =>
      macros.has(parenName ?? bareName ?? '') ? '1' : '0',
  );
  const raw = tokenize(normalized);
  const expanded = expand(raw, macros, '<expr>');
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

interface ScanState {
  macros: MacroTable;
  out: string[];
  conds: ConditionalFrame[];
  resolver?: IncludeResolver;
  pragmaOnce: Set<string>;
  depth: number;
  // Path of the file currently being scanned, for `#pragma once`.
  currentPath?: string;
}

// Parse an `#include` operand into its filename and bracket style.
function parseIncludeSpec(rest: string, line: number): { name: string; isAngle: boolean } {
  const angle = /^<([^>]*)>/.exec(rest);
  if (angle) return { name: angle[1]!, isAngle: true };
  const quoted = /^"([^"]*)"/.exec(rest);
  if (quoted) return { name: quoted[1]!, isAngle: false };
  throw new PreprocessError('malformed #include', line);
}

// Pull directives out of the source line by line, leaving blank lines in their
// place. Conditional directives keep inactive source out of the token stream;
// `#include` recursively splices resolved files in. Mutates `state`.
// C translation phase 2: a backslash at end of a physical line splices it with
// the next. The merged text stays on the first line and the consumed lines
// become blank so line numbering (and the `out` line-preservation below) stays
// aligned with the original source.
function spliceContinuations(physical: string[]): string[] {
  const lines: string[] = new Array(physical.length).fill('');
  for (let i = 0; i < physical.length; i++) {
    let cur = physical[i]!;
    let j = i;
    while (cur.replace(/\r$/, '').endsWith('\\') && j + 1 < physical.length) {
      cur = cur.replace(/\r$/, '').slice(0, -1) + physical[j + 1]!;
      j++;
    }
    lines[i] = cur;
    i = j;
  }
  return lines;
}

function processLines(source: string, state: ScanState): void {
  const { macros, out, conds } = state;
  const condBase = conds.length;
  const lines = spliceContinuations(source.split('\n'));

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
        const close = rest.indexOf(')', m[0].length + 1);
        if (close === -1) throw new PreprocessError('malformed function-like macro', i + 1);
        const paramText = rest.slice(m[0].length + 1, close).trim();
        const params =
          paramText === ''
            ? []
            : paramText.split(',').map((p) => {
                const name = p.trim();
                if (!/^[A-Za-z_]\w*$/.test(name)) {
                  throw new PreprocessError('malformed function-like macro parameter', i + 1);
                }
                return name;
              });
        const replacement = rest.slice(close + 1).trim();
        macros.set(name, {
          params,
          body: tokenize(replacement).filter((t) => t.kind !== 'eof'),
        });
        continue;
      }
      const replacement = rest.slice(m[0].length).trim();
      macros.set(name, {
        body: tokenize(replacement).filter((t) => t.kind !== 'eof'),
      });
    } else if (directive === 'undef') {
      const m = /^([A-Za-z_]\w*)/.exec(rest);
      if (m) macros.delete(m[1]!);
    } else if (directive === 'include') {
      if (!state.resolver) throw new PreprocessError('#include is not supported here', i + 1);
      if (state.depth >= MAX_INCLUDE_DEPTH) {
        throw new PreprocessError('#include nested too deeply', i + 1);
      }
      const spec = parseIncludeSpec(rest, i + 1);
      const resolved = state.resolver(spec.name, spec.isAngle);
      if (!resolved) throw new PreprocessError(`cannot find include '${spec.name}'`, i + 1);
      if (!state.pragmaOnce.has(resolved.path)) {
        const savedPath = state.currentPath;
        state.currentPath = resolved.path;
        state.depth++;
        processLines(resolved.text, state);
        state.depth--;
        state.currentPath = savedPath;
      }
    } else if (directive === 'pragma') {
      if (rest.trim() === 'once' && state.currentPath) state.pragmaOnce.add(state.currentPath);
    }
    // Other unsupported directives are intentionally ignored in this slice once
    // conditionals have selected the source.
  }

  if (conds.length !== condBase) {
    throw new PreprocessError('unterminated conditional directive', lines.length);
  }
}

// Pull directives out of the top-level translation unit and any files it
// includes, producing the combined source text plus the final macro table.
function scanDirectives(source: string, resolver?: IncludeResolver): ScanResult {
  const state: ScanState = {
    macros: new Map(),
    out: [],
    conds: [],
    resolver,
    pragmaOnce: new Set(),
    depth: 0,
  };
  processLines(source, state);
  return { text: state.out.join('\n'), macros: state.macros };
}

function parseMacroArgs(
  tokens: Token[],
  start: number,
  macro: Macro,
): { args: Token[][]; next: number } {
  const open = tokens[start];
  if (open?.text !== '(')
    throw new PreprocessError('expected macro argument list', open?.line ?? 0);
  const args: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let i = start + 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind === 'eof') throw new PreprocessError('unterminated macro argument list', tok.line);
    if (tok.text === '(') {
      depth++;
      current.push(tok);
      continue;
    }
    if (tok.text === ')') {
      if (depth === 0) {
        if (current.length > 0 || (macro.params?.length ?? 0) > 0) args.push(current);
        return { args, next: i + 1 };
      }
      depth--;
      current.push(tok);
      continue;
    }
    if (tok.text === ',' && depth === 0) {
      args.push(current);
      current = [];
      continue;
    }
    current.push(tok);
  }
  throw new PreprocessError('unterminated macro argument list', open.line);
}

// Build a string-literal token from the spelling of an argument's tokens, for
// the `#` stringize operator.
function stringize(tokens: Token[], line: number): Token {
  const text = tokens.map((t) => t.text).join(' ');
  const bytes: number[] = [];
  for (const ch of text) bytes.push(ch.codePointAt(0)! & 0xff);
  bytes.push(0);
  return { kind: 'str', text: JSON.stringify(text), line, value: 0, str: Uint8Array.from(bytes) };
}

// Concatenate two tokens' spellings into a single token for the `##` operator.
function paste(left: Token, right: Token, line: number): Token {
  const combined = left.text + right.text;
  const toks = tokenize(combined).filter((t) => t.kind !== 'eof');
  if (toks.length !== 1) {
    throw new PreprocessError(`pasting '${left.text}' and '${right.text}' is invalid`, line);
  }
  return { ...toks[0]!, line };
}

// Resolve `##` paste operators left to right in a replacement-list fragment.
function applyPaste(tokens: Token[], line: number): Token[] {
  if (!tokens.some((t) => t.kind === 'punct' && t.text === '##')) return tokens;
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind === 'punct' && tok.text === '##') {
      const right = tokens[i + 1];
      if (out.length > 0 && right) {
        out.push(paste(out.pop()!, right, line));
        i++;
      }
      // A `##` with an empty operand (placemarker) simply drops out.
      continue;
    }
    out.push(tok);
  }
  return out;
}

function substituteMacro(macro: Macro, args: Token[][], line: number): Token[] {
  const params = macro.params ?? [];
  if (args.length !== params.length) {
    throw new PreprocessError(
      `macro expects ${params.length} arguments but got ${args.length}`,
      line,
    );
  }
  const byName = new Map(params.map((name, i) => [name, args[i]!] as const));
  const out: Token[] = [];
  for (let i = 0; i < macro.body.length; i++) {
    const tok = macro.body[i]!;
    // `#param` stringizes the argument's spelling.
    if (tok.kind === 'punct' && tok.text === '#') {
      const next = macro.body[i + 1];
      if (next?.kind === 'ident' && byName.has(next.text)) {
        out.push(stringize(byName.get(next.text)!, line));
        i++;
        continue;
      }
      throw new PreprocessError("'#' is not followed by a macro parameter", line);
    }
    const arg = tok.kind === 'ident' ? byName.get(tok.text) : undefined;
    if (arg) {
      for (const a of arg) out.push({ ...a, line });
    } else {
      out.push({ ...tok, line });
    }
  }
  return applyPaste(out, line);
}

// Substitute object-like and simple function-like macros in the token stream. A
// bounded expansion depth guards against self-referential macros without a full
// hide-set.
// Build a string-literal token carrying `text` (with a trailing NUL), matching
// what the tokenizer produces for a `"..."` literal.
function stringToken(text: string, line: number): Token {
  const bytes = [...text].map((c) => c.codePointAt(0)! & 0xff);
  bytes.push(0);
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return { kind: 'str', text: `"${escaped}"`, line, value: 0, str: Uint8Array.from(bytes) };
}

function expand(tokens: Token[], macros: MacroTable, fileName: string): Token[] {
  let work = tokens;
  for (let pass = 0; pass < 16; pass++) {
    let changed = false;
    const next: Token[] = [];
    for (let i = 0; i < work.length; i++) {
      const tok = work[i]!;
      // Built-in dynamic macros: __LINE__ and __FILE__ expand based on the
      // location of the token (chibicc's add_builtin). __FILE__ resolves to the
      // translation-unit name; per-header granularity is not tracked.
      if (tok.kind === 'ident' && tok.text === '__LINE__') {
        next.push({
          kind: 'num',
          text: String(tok.line),
          line: tok.line,
          value: tok.line,
          str: new Uint8Array(0),
        });
        changed = true;
        continue;
      }
      if (tok.kind === 'ident' && tok.text === '__FILE__') {
        next.push(stringToken(fileName, tok.line));
        changed = true;
        continue;
      }
      const macro = tok.kind === 'ident' ? macros.get(tok.text) : undefined;
      if (macro) {
        if (macro.params) {
          if (work[i + 1]?.text !== '(') {
            next.push(tok);
            continue;
          }
          const parsed = parseMacroArgs(work, i + 1, macro);
          next.push(...substituteMacro(macro, parsed.args, tok.line));
          i = parsed.next - 1;
        } else {
          for (const r of applyPaste(macro.body, tok.line)) next.push({ ...r, line: tok.line });
        }
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

// Run the preprocessor: directive extraction (including `#include`),
// tokenization, and macro expansion. `resolver` supplies header text for
// `#include`; without it, `#include` is rejected.
export function preprocess(
  source: string,
  resolver?: IncludeResolver,
  fileName = '<source>',
): Token[] {
  const { text, macros } = scanDirectives(source, resolver);
  return joinAdjacentStrings(expand(tokenize(text), macros, fileName));
}

// Concatenate adjacent string literals into a single token (C11 6.4.5p5). Runs
// after macro expansion so stringized / macro-produced literals also join.
function joinAdjacentStrings(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const tok of tokens) {
    const prev = out.at(-1);
    if (tok.kind === 'str' && prev?.kind === 'str') {
      // Drop the previous literal's NUL, append the next literal's bytes.
      const merged = new Uint8Array(prev.str.length - 1 + tok.str.length);
      merged.set(prev.str.subarray(0, prev.str.length - 1), 0);
      merged.set(tok.str, prev.str.length - 1);
      out[out.length - 1] = { ...prev, str: merged, text: prev.text + tok.text };
      continue;
    }
    out.push(tok);
  }
  return out;
}
