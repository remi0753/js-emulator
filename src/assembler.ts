// アセンブラ: ニーモニックのテキスト → バイトコード (DESIGN §9-2)。
//
// CPU と同じ ISA テーブル(単一の真実)を引いてオペランドの並びを決める。
// 2 パス方式: パス1 でラベルのアドレスを確定し、パス2 でバイト列を出力する。
//
// 構文:
//   - 1 行 1 命令。';' か '#' 以降はコメント。
//   - ラベル定義は 'name:'(命令と同じ行に置いてもよい)。
//   - レジスタは R0-R7。
//   - 即値 / アドレスは 10進・0x16進・文字リテラル 'A'・ラベル名。
//   - 擬似命令: '.word v[,v...]'(32bit 値を並べる) / '.string "..."'(NUL 終端)。

import { ARG_SIZE, type ArgKind, ISA, type Mnemonic } from './isa.ts';

export interface AssembleResult {
  bytes: Uint8Array;
  labels: Map<string, number>;
  size: number;
}

// パス1 で組み立てる中間表現。
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

// オペランドを ',' で分割(文字列リテラル内のカンマは無視)。
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
  if (!m) throw new AsmError(`不正なレジスタ: '${tok}'`, line);
  return Number(m[1]);
}

// 即値 / アドレスの値を解決。ラベルは labels から引く(パス2)。
function parseValue(tok: string, labels: Map<string, number>, line: number): number {
  // 文字リテラル 'A'
  const ch = /^'(\\?.)'$/.exec(tok);
  if (ch) {
    const body = ch[1]!;
    const map: Record<string, number> = { '\\n': 10, '\\t': 9, '\\0': 0, '\\\\': 92, "\\'": 39 };
    const code = body.length === 2 ? map[body] : body.codePointAt(0);
    if (code === undefined) throw new AsmError(`不正な文字リテラル: ${tok}`, line);
    return code >>> 0;
  }
  // 16進
  if (/^[-+]?0x[0-9a-f]+$/i.test(tok)) return Number(tok) >>> 0;
  // 10進
  if (/^[-+]?\d+$/.test(tok)) return Number(tok) >>> 0;
  // ラベル
  const addr = labels.get(tok);
  if (addr === undefined) throw new AsmError(`未定義のラベル / 不正な値: '${tok}'`, line);
  return addr >>> 0;
}

function parseStringLiteral(tok: string, line: number): number[] {
  const m = /^"(.*)"$/s.exec(tok);
  if (!m) throw new AsmError(`不正な文字列リテラル: ${tok}`, line);
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
    super(`アセンブルエラー (line ${line}): ${message}`);
  }
}

export function assemble(source: string): AssembleResult {
  const rawLines = source.split('\n');
  const labels = new Map<string, number>();
  const items: Item[] = [];
  let addr = 0;

  // --- パス1: ラベル位置とレイアウトを確定 ---
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    let text = stripComment(rawLines[i]!).trim();
    if (text === '') continue;

    // 行頭の連続したラベル定義 (例: 'loop:' や 'a: b: NOP')
    const labelRe = /^([A-Za-z_.][\w.]*)\s*:\s*/;
    for (let labelMatch = labelRe.exec(text); labelMatch; labelMatch = labelRe.exec(text)) {
      const name = labelMatch[1]!;
      if (labels.has(name)) throw new AsmError(`ラベル重複: '${name}'`, lineNo);
      labels.set(name, addr);
      text = text.slice(labelMatch[0].length).trim();
    }
    if (text === '') continue;

    const spaceIdx = text.search(/\s/);
    const head = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toUpperCase();
    const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx).trim();

    // 擬似命令(データ)
    if (head === '.WORD') {
      const vals = splitOperands(rest);
      const bytes: number[] = [];
      for (const v of vals) {
        // ラベル参照は不可(値が確定していない場合があるため数値のみ)。
        const n = parseValue(v, labels, lineNo) >>> 0;
        bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
      }
      items.push({ kind: 'data', addr, bytes });
      addr += bytes.length;
      continue;
    }
    if (head === '.STRING') {
      const bytes = parseStringLiteral(rest.trim(), lineNo);
      bytes.push(0); // NUL 終端
      items.push({ kind: 'data', addr, bytes });
      addr += bytes.length;
      continue;
    }

    // 通常命令
    const spec = (ISA as Record<string, { opcode: number; args: readonly ArgKind[] }>)[head];
    if (!spec) throw new AsmError(`不明なニーモニック: '${head}'`, lineNo);
    const operands = rest === '' ? [] : splitOperands(rest);
    if (operands.length !== spec.args.length) {
      throw new AsmError(
        `'${head}' はオペランド ${spec.args.length} 個ですが ${operands.length} 個でした`,
        lineNo,
      );
    }
    items.push({ kind: 'instr', addr, mnemonic: head as Mnemonic, operands, line: lineNo });
    addr += 1 + spec.args.reduce((sum, a) => sum + ARG_SIZE[a], 0);
  }

  // --- パス2: バイト列を出力 ---
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
        write32(at, parseValue(tok, labels, item.line));
        at += 4;
      }
    });
  }

  return { bytes, labels, size };
}
