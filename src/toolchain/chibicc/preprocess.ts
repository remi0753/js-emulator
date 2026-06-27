// Minimal C preprocessor for the chibicc-derived custom32 frontend.
//
// chibicc's `preprocess.c` is a full macro/conditional engine; the Phase 31
// slice only needs object-like `#define`/`#undef` plus a tolerant pass-through
// for `#include` and conditionals (single translation unit, no real headers).
// The full preprocessor lands with Phase 32. Directive lines are stripped but
// replaced by blank lines so token line numbers still match the source.

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

// Pull `#define`/`#undef` out of the source line by line, leaving blank lines in
// their place. Other directives (`#include`, `#if*`, ...) are ignored for now.
function scanDirectives(source: string): ScanResult {
  const macros: MacroTable = new Map();
  const lines = source.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    out.push(''); // preserve line numbering

    const body = trimmed.slice(1).trim();
    const space = body.search(/\s/);
    const directive = space === -1 ? body : body.slice(0, space);
    const rest = space === -1 ? '' : body.slice(space).trim();

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
    // Every other directive is intentionally ignored in the slice.
  }

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
