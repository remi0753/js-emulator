// Assembler: mnemonic text -> bytecode.
//
// Uses the same ISA table (single source of truth) as the CPU to decide the
// operand layout. Two passes: pass 1 fixes label addresses, pass 2 emits bytes.
//
// Syntax:
//   - One instruction per line. ';' or '#' starts a comment.
//   - A label definition is 'name:' (may share a line with an instruction).
//   - Registers are R0-R7.
//   - Immediates / addresses: decimal, 0x hex, char literal 'A', or a label.
//   - Directives: '.word v[,v...]' (32-bit words) / '.string "..."' (NUL-terminated).

import { ARG_SIZE, type ArgKind, ISA, type Mnemonic } from './isa.ts';

export interface AssembleResult {
  bytes: Uint8Array;
  labels: Map<string, number>;
  size: number;
}

export interface AssembleOptions {
  externals?: ReadonlyMap<string, number> | Record<string, number>;
}

// Intermediate representation built in pass 1.
type Item =
  | { kind: 'instr'; addr: number; mnemonic: Mnemonic; operands: string[]; line: number }
  | { kind: 'data'; addr: number; bytes: number[] };

function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    else if (!inStr && (c === ';' || c === '#')) return line.slice(0, i);
  }
  return line;
}

// Split operands on ',' (commas inside a string literal are ignored).
function splitOperands(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  for (const c of s) {
    if (c === '"') {
      inStr = !inStr;
      cur += c;
    } else if (c === ',' && !inStr) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

function parseReg(tok: string, line: number): number {
  const m = /^R([0-7])$/i.exec(tok);
  if (!m) throw new AsmError(`invalid register: '${tok}'`, line);
  return Number(m[1]);
}

// Resolve the value of an immediate / address. Labels are looked up (pass 2).
function externalLookup(
  externals: AssembleOptions['externals'] | undefined,
  name: string,
): number | undefined {
  if (!externals) return undefined;
  const maybeMap = externals as ReadonlyMap<string, number>;
  if (typeof maybeMap.get === 'function') return maybeMap.get(name);
  return (externals as Record<string, number>)[name];
}

function parseValue(
  tok: string,
  labels: Map<string, number>,
  line: number,
  externals?: AssembleOptions['externals'],
): number {
  // char literal 'A'
  const ch = /^'(\\?.)'$/.exec(tok);
  if (ch) {
    const body = ch[1]!;
    const map: Record<string, number> = { '\\n': 10, '\\t': 9, '\\0': 0, '\\\\': 92, "\\'": 39 };
    const code = body.length === 2 ? map[body] : body.codePointAt(0);
    if (code === undefined) throw new AsmError(`invalid char literal: ${tok}`, line);
    return code >>> 0;
  }
  // hex
  if (/^[-+]?0x[0-9a-f]+$/i.test(tok)) return Number(tok) >>> 0;
  // decimal
  if (/^[-+]?\d+$/.test(tok)) return Number(tok) >>> 0;
  // label
  const addr = labels.get(tok);
  const external = externalLookup(externals, tok);
  if (addr === undefined && external === undefined) {
    throw new AsmError(`undefined label / invalid value: '${tok}'`, line);
  }
  if (addr === undefined) return external! >>> 0;
  return addr >>> 0;
}

function parseStringLiteral(tok: string, line: number): number[] {
  const m = /^"(.*)"$/s.exec(tok);
  if (!m) throw new AsmError(`invalid string literal: ${tok}`, line);
  const body = m[1]!;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && i + 1 < body.length) {
      const e = body[++i];
      bytes.push(e === 'n' ? 10 : e === 't' ? 9 : e === '0' ? 0 : (e!.codePointAt(0) ?? 0));
    } else {
      bytes.push(body.codePointAt(i)! & 0xff);
    }
  }
  return bytes;
}

export class AsmError extends Error {
  constructor(message: string, line: number) {
    super(`assemble error (line ${line}): ${message}`);
  }
}

// `origin` is the virtual address the emitted image will be loaded at; labels
// resolve to `origin + offset` so absolute references (jumps, LOAD/STORE) are
// correct at runtime. The byte stream itself stays compact (offset 0-based).
export function assemble(
  source: string,
  origin = 0,
  options: AssembleOptions = {},
): AssembleResult {
  const rawLines = source.split('\n');
  const labels = new Map<string, number>();
  const items: Item[] = [];
  let addr = 0;

  // --- pass 1: fix label positions and the layout ---
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    let text = stripComment(rawLines[i]!).trim();
    if (text === '') continue;

    // leading run of label definitions (e.g. 'loop:' or 'a: b: NOP')
    const labelRe = /^([A-Za-z_.][\w.]*)\s*:\s*/;
    for (let labelMatch = labelRe.exec(text); labelMatch; labelMatch = labelRe.exec(text)) {
      const name = labelMatch[1]!;
      if (labels.has(name)) throw new AsmError(`duplicate label: '${name}'`, lineNo);
      labels.set(name, origin + addr);
      text = text.slice(labelMatch[0].length).trim();
    }
    if (text === '') continue;

    const spaceIdx = text.search(/\s/);
    const head = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toUpperCase();
    const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx).trim();

    // directives (data)
    if (head === '.WORD') {
      const vals = splitOperands(rest);
      const bytes: number[] = [];
      for (const v of vals) {
        // labels are not allowed here (numbers only, since values may be unresolved).
        const n = parseValue(v, labels, lineNo, options.externals) >>> 0;
        bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
      }
      items.push({ kind: 'data', addr, bytes });
      addr += bytes.length;
      continue;
    }
    if (head === '.STRING') {
      const bytes = parseStringLiteral(rest.trim(), lineNo);
      bytes.push(0); // NUL terminator
      items.push({ kind: 'data', addr, bytes });
      addr += bytes.length;
      continue;
    }

    // normal instruction
    const spec = (ISA as Record<string, { opcode: number; args: readonly ArgKind[] }>)[head];
    if (!spec) throw new AsmError(`unknown mnemonic: '${head}'`, lineNo);
    const operands = rest === '' ? [] : splitOperands(rest);
    if (operands.length !== spec.args.length) {
      throw new AsmError(
        `'${head}' takes ${spec.args.length} operand(s) but got ${operands.length}`,
        lineNo,
      );
    }
    items.push({ kind: 'instr', addr, mnemonic: head as Mnemonic, operands, line: lineNo });
    addr += 1 + spec.args.reduce((sum, a) => sum + ARG_SIZE[a], 0);
  }

  // --- pass 2: emit the byte stream ---
  const size = addr;
  const bytes = new Uint8Array(size);
  const write32 = (at: number, v: number) => {
    const u = v >>> 0;
    bytes[at] = u & 0xff;
    bytes[at + 1] = (u >>> 8) & 0xff;
    bytes[at + 2] = (u >>> 16) & 0xff;
    bytes[at + 3] = (u >>> 24) & 0xff;
  };

  for (const item of items) {
    if (item.kind === 'data') {
      bytes.set(item.bytes, item.addr);
      continue;
    }
    const spec = ISA[item.mnemonic];
    let at = item.addr;
    bytes[at++] = spec.opcode;
    spec.args.forEach((kind, idx) => {
      const tok = item.operands[idx]!;
      if (kind === 'reg') {
        bytes[at] = parseReg(tok, item.line);
        at += 1;
      } else {
        write32(at, parseValue(tok, labels, item.line, options.externals));
        at += 4;
      }
    });
  }

  return { bytes, labels, size };
}
