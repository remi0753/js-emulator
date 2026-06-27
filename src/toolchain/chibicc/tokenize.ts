// Tokenizer for the chibicc-derived custom32 C frontend.
//
// This is a TypeScript port of chibicc's `tokenize.c` (see ./PROVENANCE.md),
// scoped to the Phase 31 backend slice. It turns C source into a flat array of
// tokens. The structure mirrors upstream: a keyword set, longest-match
// punctuators, decimal/hex/char numeric literals, escaped string literals, and
// `//` / `/* */` comments. Target-specific concerns live in `codegen.ts`, not
// here, so the front of the pipeline stays target independent.

export type TokenKind = 'ident' | 'punct' | 'keyword' | 'num' | 'str' | 'eof';

export interface Token {
  kind: TokenKind;
  // Source text of the token (its spelling).
  text: string;
  // 1-based line number, for diagnostics.
  line: number;
  // Numeric value for `num` tokens (already evaluated, including char literals).
  value: number;
  // Decoded bytes for `str` tokens, including the trailing NUL terminator.
  str: Uint8Array;
}

export class TokenizeError extends Error {
  constructor(message: string, line: number) {
    super(`tokenize error (line ${line}): ${message}`);
  }
}

// Reserved words recognized by the slice. typedef/enum/struct/union and the
// other storage classes arrive with Phase 32's broader language support.
const KEYWORDS = new Set([
  'return',
  'if',
  'else',
  'while',
  'do',
  'for',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'sizeof',
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
]);

// Punctuators, longest first so the scanner takes the maximal munch.
const PUNCTUATORS = [
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '->',
  '+',
  '-',
  '*',
  '/',
  '%',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ';',
  ',',
  '=',
  '<',
  '>',
  '&',
  '|',
  '^',
  '!',
  '~',
  '.',
  ':',
];

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

// Decode a single backslash escape starting at `src[i]` (with `src[i] === '\\'`).
// Returns the byte value and the index just past the escape.
function readEscape(src: string, i: number, line: number): { value: number; next: number } {
  const c = src[i + 1];
  if (c === undefined) throw new TokenizeError('unterminated escape sequence', line);
  const simple: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '0': 0,
    '\\': 92,
    "'": 39,
    '"': 34,
  };
  if (c in simple) return { value: simple[c]!, next: i + 2 };
  if (c === 'x') {
    let j = i + 2;
    let value = 0;
    while (j < src.length && /[0-9a-fA-F]/.test(src[j]!)) {
      value = value * 16 + Number.parseInt(src[j]!, 16);
      j++;
    }
    return { value: value & 0xff, next: j };
  }
  // Unknown escapes pass the literal character through, matching C's lenient
  // handling for the common cases the slice needs.
  return { value: c.codePointAt(0)! & 0xff, next: i + 2 };
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;

  const push = (kind: TokenKind, text: string, extra?: Partial<Token>): void => {
    tokens.push({ kind, text, line, value: 0, str: new Uint8Array(0), ...extra });
  };

  while (i < source.length) {
    const c = source[i]!;

    // Newlines / whitespace.
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }

    // Comments.
    if (c === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      if (i >= source.length) throw new TokenizeError('unterminated block comment', line);
      i += 2;
      continue;
    }

    // Identifiers and keywords.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < source.length && isIdentChar(source[j]!)) j++;
      const text = source.slice(i, j);
      push(KEYWORDS.has(text) ? 'keyword' : 'ident', text);
      i = j;
      continue;
    }

    // Numeric literals (decimal and hex).
    if (isDigit(c)) {
      let j = i;
      let value: number;
      if (c === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        j = i + 2;
        while (j < source.length && /[0-9a-fA-F]/.test(source[j]!)) j++;
        value = Number.parseInt(source.slice(i + 2, j), 16) >>> 0;
      } else {
        while (j < source.length && isDigit(source[j]!)) j++;
        value = Number.parseInt(source.slice(i, j), 10) >>> 0;
      }
      // Skip integer suffixes (u/l) without interpreting them in the slice.
      while (j < source.length && /[uUlL]/.test(source[j]!)) j++;
      push('num', source.slice(i, j), { value });
      i = j;
      continue;
    }

    // Character literal -> numeric token.
    if (c === "'") {
      let value: number;
      let j: number;
      if (source[i + 1] === '\\') {
        const esc = readEscape(source, i + 1, line);
        value = esc.value;
        j = esc.next;
      } else {
        const ch = source[i + 1];
        if (ch === undefined) throw new TokenizeError('unterminated char literal', line);
        value = ch.codePointAt(0)! & 0xff;
        j = i + 2;
      }
      if (source[j] !== "'") throw new TokenizeError('unterminated char literal', line);
      push('num', source.slice(i, j + 1), { value });
      i = j + 1;
      continue;
    }

    // String literal.
    if (c === '"') {
      const bytes: number[] = [];
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\n') throw new TokenizeError('unterminated string literal', line);
        if (source[j] === '\\') {
          const esc = readEscape(source, j, line);
          bytes.push(esc.value);
          j = esc.next;
        } else {
          bytes.push(source.codePointAt(j)! & 0xff);
          j++;
        }
      }
      if (j >= source.length) throw new TokenizeError('unterminated string literal', line);
      bytes.push(0); // C strings carry a NUL terminator.
      push('str', source.slice(i, j + 1), { str: Uint8Array.from(bytes) });
      i = j + 1;
      continue;
    }

    // Punctuators (maximal munch).
    const punct = PUNCTUATORS.find((p) => source.startsWith(p, i));
    if (punct) {
      push('punct', punct);
      i += punct.length;
      continue;
    }

    throw new TokenizeError(`invalid character '${c}'`, line);
  }

  push('eof', '');
  return tokens;
}
