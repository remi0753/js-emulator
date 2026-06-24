import { assemble } from '../assembler.ts';
import { LAYOUT } from '../v2/kernel/abi.ts';
import { type Executable, SEG } from '../v2/kernel/exec.ts';
import {
  cTypesEqual,
  functionTypesEqual,
  type BssSymbol,
  type CompiledObject,
  type CType,
  type DataSymbol,
  type FunctionSig,
  type SourceLocation,
} from './c.ts';

export interface LinkOptions {
  textOrigin?: number;
  dataOrigin?: number;
  entry?: string;
}

export interface LinkedImage {
  executable: Executable;
  entry: number;
  symbols: Map<string, number>;
  sourceMap: Map<number, SourceLocation>;
  text: Uint8Array;
  data: Uint8Array;
  dataMemSize: number;
}

export interface KernelImage {
  entry: number;
  symbols: Map<string, number>;
  sourceMap: Map<number, SourceLocation>;
  segments: { vaddr: number; data: Uint8Array; memSize: number; flags: number }[];
  flat: Uint8Array;
}

const SHARED_TEXT_LABELS = new Set([
  'memcpy',
  'memcpy_loop',
  'memcpy_done',
  'memset',
  'memset_loop',
  'memset_done',
  'strlen',
  'strlen_loop',
  'strlen_done',
  'strcmp',
  'strcmp_loop',
  'strcmp_diff',
  'strcmp_eq',
  'strcmp_done',
]);

const SHARED_DATA_SYMBOLS = new Set(['__csp', '__stack']);

export function linkExecutable(objects: CompiledObject[], options: LinkOptions = {}): LinkedImage {
  const textOrigin = options.textOrigin ?? LAYOUT.USER_TEXT;
  const entryName = options.entry ?? '_start';
  validateCrossObjectTypes(objects);
  rejectReservedRuntimeDefinitions(objects);
  // Objects may each carry crt0 + the runtime helpers (identical, shared
  // symbols). Drop duplicate label-led blocks so several objects can link
  // together; each object's private labels are already namespaced.
  const textSource = dedupeText(objects.map((o) => o.text).join('\n'));

  const textProbe = assemble(textSource, textOrigin, { externals: zeroDataSymbols(objects) });
  const dataOrigin = options.dataOrigin ?? align(textOrigin + textProbe.size, 0x1000);
  const { data, memSize, symbols } = layoutData(objects, dataOrigin);

  const text = assemble(textSource, textOrigin, { externals: symbols });
  for (const [name, addr] of text.labels) symbols.set(name, addr);

  const entry = symbols.get(entryName);
  if (entry === undefined) throw new Error(`link: entry symbol not found: ${entryName}`);

  const sourceMap = new Map<number, SourceLocation>();
  for (const obj of objects) {
    for (const [name, location] of obj.sourceMap) {
      const addr = symbols.get(name);
      if (addr !== undefined) sourceMap.set(addr, location);
    }
  }

  return {
    executable: {
      entry,
      segments: [
        { vaddr: textOrigin, data: text.bytes, memSize: text.bytes.length, flags: SEG.R | SEG.X },
        { vaddr: dataOrigin, data, memSize, flags: SEG.R | SEG.W },
      ],
    },
    entry,
    symbols,
    sourceMap,
    text: text.bytes,
    data,
    dataMemSize: memSize,
  };
}

function validateCrossObjectTypes(objects: CompiledObject[]): void {
  const globals = new Map<string, CType>();
  const functions = new Map<string, FunctionSig>();

  for (const obj of objects) {
    for (const [name, type] of obj.globals) {
      if (functions.has(name)) {
        throw new Error(`link: symbol declared as both object and function: ${name}`);
      }
      const prior = globals.get(name);
      if (prior && !cTypesEqual(prior, type)) {
        throw new Error(`link: conflicting object types for ${name}`);
      }
      globals.set(name, type);
    }
    for (const [name, sig] of obj.functions) {
      if (globals.has(name)) {
        throw new Error(`link: symbol declared as both object and function: ${name}`);
      }
      const prior = functions.get(name);
      if (prior && !functionTypesEqual(prior, sig)) {
        throw new Error(`link: conflicting function types for ${name}`);
      }
      functions.set(name, sig);
    }
  }
}

function rejectReservedRuntimeDefinitions(objects: CompiledObject[]): void {
  for (const obj of objects) {
    for (const name of SHARED_TEXT_LABELS) {
      if (obj.sourceMap.has(name)) {
        throw new Error(`link: duplicate text symbol: ${name}`);
      }
    }
    for (const name of SHARED_DATA_SYMBOLS) {
      if (obj.globals.has(name)) {
        throw new Error(`link: duplicate data symbol: ${name}`);
      }
    }
  }
}

export function linkKernelImage(objects: CompiledObject[], options: LinkOptions = {}): KernelImage {
  const textOrigin = options.textOrigin ?? 0;
  let dataOrigin = options.dataOrigin;
  if (dataOrigin === undefined) {
    const textSource = dedupeText(objects.map((o) => o.text).join('\n'));
    const textProbe = assemble(textSource, textOrigin, { externals: zeroDataSymbols(objects) });
    dataOrigin = align(textOrigin + textProbe.size, 0x1000);
  }
  const linked = linkExecutable(objects, {
    textOrigin,
    dataOrigin,
    entry: options.entry ?? '_start',
  });
  const segments = linked.executable.segments;
  assertNoOverlap(segments);
  const end = Math.max(...segments.map((s) => s.vaddr + s.memSize));
  const flat = new Uint8Array(end);
  for (const s of segments) flat.set(s.data, s.vaddr);
  return {
    entry: linked.entry,
    symbols: linked.symbols,
    sourceMap: linked.sourceMap,
    segments,
    flat,
  };
}

// Drops duplicate top-level label blocks (keeping the first), so shared crt0 /
// runtime helpers emitted by every object appear once in the linked image.
function dedupeText(text: string): string {
  const seen = new Map<string, string>();
  const out: string[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const label = /^([A-Za-z_]\w*):$/.exec(lines[i]!.trim());
    if (!label) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    const name = label[1]!;
    let end = i + 1;
    while (end < lines.length && !/^([A-Za-z_]\w*):$/.test(lines[end]!.trim())) end++;
    const block = lines.slice(i, end).join('\n');
    const prior = seen.get(name);
    if (prior !== undefined) {
      if (!SHARED_TEXT_LABELS.has(name) || prior !== block) {
        throw new Error(`link: duplicate text symbol: ${name}`);
      }
    } else {
      seen.set(name, block);
      out.push(...lines.slice(i, end));
    }
    i = end;
  }
  return out.join('\n');
}

function assertNoOverlap(segments: KernelImage['segments']): void {
  const sorted = [...segments].sort((a, b) => a.vaddr - b.vaddr);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const prevEnd = prev.vaddr + prev.memSize;
    if (cur.vaddr < prevEnd) {
      throw new Error(
        `link: kernel segments overlap: 0x${prev.vaddr.toString(16)}..0x${prevEnd.toString(16)} and 0x${cur.vaddr.toString(16)}`,
      );
    }
  }
}

function zeroDataSymbols(objects: CompiledObject[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const obj of objects) {
    for (const d of obj.data) out.set(d.name, 0);
    for (const b of obj.bss) out.set(b.name, 0);
  }
  return out;
}

function layoutData(
  objects: CompiledObject[],
  origin: number,
): { data: Uint8Array; memSize: number; symbols: Map<string, number> } {
  // Deduplicate by name (keep first): shared symbols such as the C software
  // stack (`__csp` / `__stack`) are emitted by every object.
  const seen = new Set<string>();
  const dataSyms: DataSymbol[] = [];
  const bssSyms: BssSymbol[] = [];
  for (const obj of objects) {
    for (const d of obj.data) {
      if (seen.has(d.name)) {
        if (SHARED_DATA_SYMBOLS.has(d.name)) continue;
        throw new Error(`link: duplicate data symbol: ${d.name}`);
      }
      seen.add(d.name);
      dataSyms.push(d);
    }
    for (const b of obj.bss) {
      if (seen.has(b.name)) {
        if (SHARED_DATA_SYMBOLS.has(b.name)) continue;
        throw new Error(`link: duplicate bss symbol: ${b.name}`);
      }
      seen.add(b.name);
      bssSyms.push(b);
    }
  }

  const symbols = new Map<string, number>();
  const placed: { sym: DataSymbol; off: number }[] = [];
  let dataSize = 0;
  for (const sym of dataSyms) {
    dataSize = align(dataSize, 4);
    symbols.set(sym.name, origin + dataSize);
    placed.push({ sym, off: dataSize });
    dataSize += align(Math.max(sym.bytes.length, sym.size), 4);
  }

  let memSize = dataSize;
  for (const sym of bssSyms) {
    memSize = align(memSize, 4);
    symbols.set(sym.name, origin + memSize);
    memSize += align(sym.size, 4);
  }

  const data = new Uint8Array(dataSize);
  for (const { sym, off } of placed) {
    data.set(sym.bytes, off);
    for (const reloc of sym.relocs ?? []) {
      const target = symbols.get(reloc.target);
      if (target === undefined)
        throw new Error(`link: relocation target not found: ${reloc.target}`);
      writeWord(data, off + reloc.offset, target);
    }
  }
  return { data, memSize, symbols };
}

function writeWord(buf: Uint8Array, at: number, value: number): void {
  const u = value >>> 0;
  buf[at] = u & 0xff;
  buf[at + 1] = (u >>> 8) & 0xff;
  buf[at + 2] = (u >>> 16) & 0xff;
  buf[at + 3] = (u >>> 24) & 0xff;
}

function align(n: number, a: number): number {
  return (n + a - 1) & ~(a - 1);
}
