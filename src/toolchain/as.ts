// Relocatable assembler: assembly text -> a custom32 object file.
//
// Unlike `src/assembler.ts` (which resolves every label to an absolute address
// at a fixed origin), this assembler emits position-independent section bytes
// plus a symbol table and relocations, so the linker can place sections at any
// address and resolve cross-object references. It shares the same ISA table.
//
// Syntax:
//   - One instruction per line. ';' or '#' starts a comment.
//   - `name:` defines a label in the current section (may share a line).
//   - Registers are R0-R7. Immediates: decimal, 0x hex, or 'A' char literal.
//   - A bare identifier operand (or `.word`/`.byte` value) is a symbol
//     reference; the assembler emits an ABS32 relocation against it. An
//     optional `+N`/`-N` addend is supported (e.g. `MOV R1, msg+4`).
//   - Section directives: `.text` `.data` `.bss` (default is `.text`).
//   - `.global name` / `.globl name` exports a symbol.
//   - Data: `.word v[,v...]` `.byte v[,v...]` `.string "..."` (NUL-terminated)
//     `.space N` / `.zero N` (reserve N zero bytes; in `.bss` reserves space).

import type {
  ObjectFile,
  ObjReloc,
  ObjSymbol,
  RelocSection,
  SymBinding,
} from '../formats/object.ts';
import { type ArgKind, ISA } from '../isa.ts';

export class AssembleError extends Error {
  constructor(message: string, line: number) {
    super(`assemble error (line ${line}): ${message}`);
  }
}

type Section = 'text' | 'data' | 'bss';

interface PendingReloc {
  section: RelocSection;
  offset: number;
  name: string;
  addend: number;
}

interface SymDef {
  section: Section;
  value: number;
}

function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    else if (!inStr && (c === ';' || c === '#')) return line.slice(0, i);
  }
  return line;
}

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
  if (!m) throw new AssembleError(`invalid register: '${tok}'`, line);
  return Number(m[1]);
}

function parseCharLiteral(tok: string): number | undefined {
  const ch = /^'(\\?.)'$/.exec(tok);
  if (!ch) return undefined;
  const body = ch[1]!;
  const map: Record<string, number> = { '\\n': 10, '\\t': 9, '\\0': 0, '\\\\': 92, "\\'": 39 };
  const code = body.length === 2 ? map[body] : body.codePointAt(0);
  if (code === undefined) return undefined;
  return code >>> 0;
}

// Returns the constant value of a literal token, or undefined if it is a symbol
// reference (a bare identifier, optionally with a +N/-N addend).
function constantValue(tok: string): number | undefined {
  const ch = parseCharLiteral(tok);
  if (ch !== undefined) return ch;
  if (/^[-+]?0x[0-9a-f]+$/i.test(tok)) return Number(tok) >>> 0;
  if (/^[-+]?\d+$/.test(tok)) return Number(tok) >>> 0;
  return undefined;
}

// Splits a symbol reference into its name and an optional numeric addend.
function parseSymbolRef(tok: string, line: number): { name: string; addend: number } {
  const m = /^([A-Za-z_.][\w.]*)\s*(?:([+-])\s*(0x[0-9a-fA-F]+|\d+))?$/.exec(tok);
  if (!m) throw new AssembleError(`invalid value / undefined symbol: '${tok}'`, line);
  const name = m[1]!;
  if (!m[2]) return { name, addend: 0 };
  const magnitude = Number(m[3]);
  return { name, addend: m[2] === '-' ? -magnitude : magnitude };
}

function parseStringLiteral(tok: string, line: number): number[] {
  const m = /^"(.*)"$/s.exec(tok);
  if (!m) throw new AssembleError(`invalid string literal: ${tok}`, line);
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

export function assembleObject(source: string, name = 'a.o'): ObjectFile {
  const textBytes: number[] = [];
  const dataBytes: number[] = [];
  let bssSize = 0;
  let section: Section = 'text';
  const defs = new Map<string, SymDef>();
  const globals = new Set<string>();
  const pendingRelocs: PendingReloc[] = [];
  // Track first-seen order of referenced names so undefined symbols emit
  // deterministically.
  const referenced: string[] = [];
  const referencedSet = new Set<string>();

  const curLen = (): number =>
    section === 'text' ? textBytes.length : section === 'data' ? dataBytes.length : bssSize;

  const emit = (bytes: number[], line: number): void => {
    if (section === 'bss') {
      throw new AssembleError('cannot emit data in the .bss section', line);
    }
    (section === 'text' ? textBytes : dataBytes).push(...bytes);
  };

  const reserve = (n: number): void => {
    if (section === 'bss') bssSize += n;
    else (section === 'text' ? textBytes : dataBytes).push(...new Array<number>(n).fill(0));
  };

  const noteReference = (refName: string): void => {
    if (!referencedSet.has(refName)) {
      referencedSet.add(refName);
      referenced.push(refName);
    }
  };

  // Emit a 32-bit field: a constant value, or a placeholder plus an ABS32
  // relocation against a symbol reference.
  const emitWord = (tok: string, line: number): void => {
    const constant = constantValue(tok);
    if (constant !== undefined) {
      emit(
        [
          constant & 0xff,
          (constant >>> 8) & 0xff,
          (constant >>> 16) & 0xff,
          (constant >>> 24) & 0xff,
        ],
        line,
      );
      return;
    }
    const { name: refName, addend } = parseSymbolRef(tok, line);
    if (section === 'bss') {
      throw new AssembleError('relocation in the .bss section', line);
    }
    noteReference(refName);
    pendingRelocs.push({ section, offset: curLen(), name: refName, addend });
    emit([0, 0, 0, 0], line);
  };

  const rawLines = source.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    let text = stripComment(rawLines[i]!).trim();
    if (text === '') continue;

    // Leading run of label definitions.
    const labelRe = /^([A-Za-z_.][\w.]*)\s*:\s*/;
    for (let labelMatch = labelRe.exec(text); labelMatch; labelMatch = labelRe.exec(text)) {
      const label = labelMatch[1]!;
      if (defs.has(label)) throw new AssembleError(`duplicate label: '${label}'`, lineNo);
      defs.set(label, { section, value: curLen() });
      text = text.slice(labelMatch[0].length).trim();
    }
    if (text === '') continue;

    const spaceIdx = text.search(/\s/);
    const head = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toUpperCase();
    const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx).trim();

    // Directives.
    if (head === '.TEXT' || head === '.DATA' || head === '.BSS') {
      section = head.slice(1).toLowerCase() as Section;
      continue;
    }
    if (head === '.GLOBAL' || head === '.GLOBL') {
      for (const sym of splitOperands(rest)) globals.add(sym);
      continue;
    }
    if (head === '.WORD') {
      for (const v of splitOperands(rest)) emitWord(v, lineNo);
      continue;
    }
    if (head === '.BYTE') {
      for (const v of splitOperands(rest)) {
        const value = constantValue(v);
        if (value === undefined)
          throw new AssembleError(`.byte requires a constant: '${v}'`, lineNo);
        emit([value & 0xff], lineNo);
      }
      continue;
    }
    if (head === '.STRING') {
      const bytes = parseStringLiteral(rest.trim(), lineNo);
      bytes.push(0); // NUL terminator
      emit(bytes, lineNo);
      continue;
    }
    if (head === '.SPACE' || head === '.ZERO') {
      const value = constantValue(rest.trim());
      if (value === undefined)
        throw new AssembleError(`${head.toLowerCase()} requires a constant`, lineNo);
      reserve(value);
      continue;
    }

    // Instruction.
    if (section !== 'text') {
      throw new AssembleError(`instruction '${head}' outside the .text section`, lineNo);
    }
    const spec = (ISA as Record<string, { opcode: number; args: readonly ArgKind[] }>)[head];
    if (!spec) throw new AssembleError(`unknown mnemonic: '${head}'`, lineNo);
    const operands = rest === '' ? [] : splitOperands(rest);
    if (operands.length !== spec.args.length) {
      throw new AssembleError(
        `'${head}' takes ${spec.args.length} operand(s) but got ${operands.length}`,
        lineNo,
      );
    }
    emit([spec.opcode], lineNo);
    spec.args.forEach((kind, idx) => {
      const tok = operands[idx]!;
      if (kind === 'reg') emit([parseReg(tok, lineNo)], lineNo);
      else emitWord(tok, lineNo);
    });
  }

  return finalize(name, textBytes, dataBytes, bssSize, defs, globals, pendingRelocs, referenced);
}

function finalize(
  name: string,
  textBytes: number[],
  dataBytes: number[],
  bssSize: number,
  defs: Map<string, SymDef>,
  globals: Set<string>,
  pendingRelocs: PendingReloc[],
  referenced: string[],
): ObjectFile {
  const symbols: ObjSymbol[] = [];
  const indexOf = new Map<string, number>();

  // Defined symbols first, in definition order.
  for (const [symName, def] of defs) {
    const binding: SymBinding = globals.has(symName) ? 'global' : 'local';
    indexOf.set(symName, symbols.length);
    symbols.push({ name: symName, section: def.section, binding, value: def.value });
  }
  // Undefined symbols: referenced or exported but not defined here.
  const undefinedNames: string[] = [];
  for (const ref of referenced) if (!defs.has(ref)) undefinedNames.push(ref);
  for (const g of globals)
    if (!defs.has(g) && !referencedSetHas(undefinedNames, g)) undefinedNames.push(g);
  for (const symName of undefinedNames) {
    if (indexOf.has(symName)) continue;
    indexOf.set(symName, symbols.length);
    symbols.push({ name: symName, section: 'undef', binding: 'global', value: 0 });
  }

  const relocs: ObjReloc[] = pendingRelocs.map((reloc) => ({
    section: reloc.section,
    offset: reloc.offset,
    symbol: indexOf.get(reloc.name)!,
    type: 'abs32',
    addend: reloc.addend,
  }));

  return {
    name,
    text: Uint8Array.from(textBytes),
    data: Uint8Array.from(dataBytes),
    bssSize,
    symbols,
    relocs,
  };
}

function referencedSetHas(list: string[], value: string): boolean {
  return list.includes(value);
}
