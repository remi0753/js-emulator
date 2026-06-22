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

// Drops duplicate top-level label blocks (keeping the first), so shared crt0 /
// runtime helpers emitted by every object appear once in the linked image.
function dedupeText(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const label = /^([A-Za-z_]\w*):$/.exec(line.trim());
    if (label) {
      if (seen.has(label[1]!)) {
        skipping = true;
        continue;
      }
      seen.add(label[1]!);
      skipping = false;
      out.push(line);
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
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
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      dataSyms.push(d);
    }
    for (const b of obj.bss) {
      if (seen.has(b.name)) continue;
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
      if (target === undefined) throw new Error(`link: relocation target not found: ${reloc.target}`);
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
