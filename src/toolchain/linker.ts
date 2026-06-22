import { assemble } from '../assembler.ts';
import { LAYOUT } from '../v2/kernel/abi.ts';
import { type Executable, SEG } from '../v2/kernel/exec.ts';
import type { BssSymbol, CompiledObject, DataSymbol, SourceLocation } from './c.ts';

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

export function linkExecutable(objects: CompiledObject[], options: LinkOptions = {}): LinkedImage {
  const textOrigin = options.textOrigin ?? LAYOUT.USER_TEXT;
  const entryName = options.entry ?? '_start';
  const textSource = objects.map((o) => o.text).join('\n');

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

export function linkKernelImage(objects: CompiledObject[], options: LinkOptions = {}): KernelImage {
  const linked = linkExecutable(objects, {
    textOrigin: options.textOrigin ?? 0,
    dataOrigin: options.dataOrigin ?? 0x8000,
    entry: options.entry ?? '_start',
  });
  const segments = linked.executable.segments;
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
  const dataSyms: DataSymbol[] = [];
  const bssSyms: BssSymbol[] = [];
  for (const obj of objects) {
    dataSyms.push(...obj.data);
    bssSyms.push(...obj.bss);
  }

  const symbols = new Map<string, number>();
  let dataSize = 0;
  for (const sym of dataSyms) {
    dataSize = align(dataSize, 4);
    symbols.set(sym.name, origin + dataSize);
    dataSize += align(Math.max(sym.bytes.length, sym.size), 4);
  }

  let memSize = dataSize;
  for (const sym of bssSyms) {
    memSize = align(memSize, 4);
    symbols.set(sym.name, origin + memSize);
    memSize += align(sym.size, 4);
  }

  const data = new Uint8Array(dataSize);
  let off = 0;
  for (const sym of dataSyms) {
    off = align(off, 4);
    data.set(sym.bytes, off);
    off += align(Math.max(sym.bytes.length, sym.size), 4);
  }
  return { data, memSize, symbols };
}

function align(n: number, a: number): number {
  return (n + a - 1) & ~(a - 1);
}
