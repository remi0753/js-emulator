// Object linker: relocatable objects + archives -> a loadable executable.
//
// This is the object-file counterpart to the source-level `linker.ts`. It takes
// fully assembled `ObjectFile`s (from `as.ts`) plus static archives, resolves
// global/undefined symbols, pulls archive members on demand, lays out the
// text/data/bss sections at concrete addresses, applies relocations, and emits
// the shared `Executable` format. A thin helper flattens the result into the
// guest's loadable header format.
//
// Layout: all text sections first (at `textOrigin`), then data at the next page
// boundary, then bss. Each object's same-kind sections are concatenated in input
// order (then archive pull order) and padded to a 4-byte boundary. Output is
// deterministic for a given input order, and the emitted JEX segments remain
// page-aligned for the generic executable loader.

import type { Archive } from '../formats/archive.ts';
import { type Executable, SEG } from '../formats/executable.ts';
import { type ObjectFile, parseObject } from '../formats/object.ts';

export interface LinkObjectsOptions {
  textOrigin?: number;
  entry?: string;
  gcSections?: boolean;
  includeLocals?: boolean; // TEMP profiling: also map local text symbols
}

export interface LinkedObjects {
  executable: Executable;
  entry: number;
  symbols: Map<string, number>; // global symbol name -> resolved address
}

export interface KernelImage {
  entry: number;
  symbols: Map<string, number>;
  segments: { vaddr: number; data: Uint8Array; memSize: number; flags: number }[];
  flat: Uint8Array;
}

const DEFAULT_TEXT_ORIGIN = 0x1000;
const PAGE_SIZE = 4096;

interface PlacedObject {
  obj: ObjectFile;
  textBase: number;
  dataBase: number;
  bssBase: number;
}

function align(n: number, a: number): number {
  return (n + a - 1) & ~(a - 1);
}

function writeWord(buf: Uint8Array, at: number, value: number): void {
  const u = value >>> 0;
  buf[at] = u & 0xff;
  buf[at + 1] = (u >>> 8) & 0xff;
  buf[at + 2] = (u >>> 16) & 0xff;
  buf[at + 3] = (u >>> 24) & 0xff;
}

// Names a (global, non-undefined) object exports.
function provided(obj: ObjectFile): string[] {
  return obj.symbols
    .filter((s) => s.binding === 'global' && s.section !== 'undef')
    .map((s) => s.name);
}

// Names an object references but does not define (undefined symbols).
function required(obj: ObjectFile): string[] {
  return obj.symbols.filter((s) => s.section === 'undef').map((s) => s.name);
}

export function linkObjects(
  objects: ObjectFile[],
  archives: Archive[] = [],
  options: LinkObjectsOptions = {},
): LinkedObjects {
  const textOrigin = options.textOrigin ?? DEFAULT_TEXT_ORIGIN;
  const entryName = options.entry ?? '_start';
  if (textOrigin % PAGE_SIZE !== 0) {
    throw new Error('link: text origin must be page-aligned');
  }

  // Symbol resolution: load the explicit objects, then repeatedly pull archive
  // members that satisfy a still-undefined symbol until a fixed point.
  const loaded: ObjectFile[] = [];
  const defined = new Map<string, ObjectFile>();
  const needed = new Set<string>();

  const admit = (obj: ObjectFile): void => {
    for (const name of provided(obj)) {
      if (defined.has(name)) throw new Error(`link: duplicate global symbol: ${name}`);
      defined.set(name, obj);
      needed.delete(name);
    }
    for (const name of required(obj)) if (!defined.has(name)) needed.add(name);
    loaded.push(obj);
  };

  for (const obj of objects) admit(obj);

  const pulled = new Set<ArchiveMemberKey>();
  let progress = true;
  while (progress && needed.size > 0) {
    progress = false;
    for (let a = 0; a < archives.length; a++) {
      const archive = archives[a]!;
      for (let m = 0; m < archive.members.length; m++) {
        const key: ArchiveMemberKey = `${a}:${m}`;
        if (pulled.has(key)) continue;
        const member = parseObject(archive.members[m]!.data);
        if (!provided(member).some((name) => needed.has(name))) continue;
        pulled.add(key);
        admit(member);
        progress = true;
      }
    }
  }

  if (needed.size > 0) {
    throw new Error(`link: undefined symbol(s): ${[...needed].sort().join(', ')}`);
  }

  const linkInputs = options.gcSections === true ? gcText(loaded, entryName) : loaded;

  // Layout: text, then data, then bss.
  const placed: PlacedObject[] = [];
  let textCursor = textOrigin;
  for (const obj of linkInputs) {
    placed.push({ obj, textBase: textCursor, dataBase: 0, bssBase: 0 });
    textCursor = align(textCursor + obj.text.length, 4);
  }
  const textEnd = textCursor;
  const dataStart = align(textEnd, PAGE_SIZE);
  let dataCursor = dataStart;
  for (const p of placed) {
    p.dataBase = dataCursor;
    dataCursor = align(dataCursor + p.obj.data.length, 4);
  }
  const dataEnd = dataCursor;
  let bssCursor = dataEnd;
  for (const p of placed) {
    p.bssBase = bssCursor;
    bssCursor = align(bssCursor + p.obj.bssSize, 4);
  }
  const memEnd = bssCursor;

  // Resolve the address of a symbol defined inside a specific placed object.
  const localAddr = (p: PlacedObject, symIndex: number): number => {
    const sym = p.obj.symbols[symIndex]!;
    switch (sym.section) {
      case 'text':
        return p.textBase + sym.value;
      case 'data':
        return p.dataBase + sym.value;
      case 'bss':
        return p.bssBase + sym.value;
      case 'abs':
        return sym.value;
      default:
        throw new Error(`link: ${p.obj.name}: cannot resolve undefined symbol ${sym.name}`);
    }
  };

  // Global symbol table: name -> resolved address.
  const globalAddrs = new Map<string, number>();
  for (const p of placed) {
    p.obj.symbols.forEach((sym, index) => {
      if (sym.binding === 'global' && sym.section !== 'undef') {
        globalAddrs.set(sym.name, localAddr(p, index));
      } else if (options.includeLocals && sym.section === 'text' && !sym.name.startsWith('.L')) {
        globalAddrs.set(`${p.obj.name}:${sym.name}`, localAddr(p, index));
      }
    });
  }

  // Compose section bytes and apply relocations.
  const text = new Uint8Array(textEnd - textOrigin);
  const data = new Uint8Array(dataEnd - dataStart);
  for (const p of placed) {
    text.set(p.obj.text, p.textBase - textOrigin);
    data.set(p.obj.data, p.dataBase - dataStart);
  }
  for (const p of placed) {
    for (const reloc of p.obj.relocs) {
      const sym = p.obj.symbols[reloc.symbol]!;
      let addr: number;
      if (sym.section === 'undef') {
        const resolved = globalAddrs.get(sym.name);
        if (resolved === undefined) throw new Error(`link: undefined symbol: ${sym.name}`);
        addr = resolved;
      } else {
        addr = localAddr(p, reloc.symbol);
      }
      const value = (addr + reloc.addend) >>> 0;
      if (reloc.section === 'text') writeWord(text, p.textBase - textOrigin + reloc.offset, value);
      else writeWord(data, p.dataBase - dataStart + reloc.offset, value);
    }
  }

  const entry = globalAddrs.get(entryName);
  if (entry === undefined) throw new Error(`link: entry symbol not found: ${entryName}`);

  const executable: Executable = {
    entry,
    segments: [
      { vaddr: textOrigin, data: text, memSize: text.length, flags: SEG.R | SEG.X },
      { vaddr: dataStart, data, memSize: memEnd - dataStart, flags: SEG.R | SEG.W },
    ],
  };
  return { executable, entry, symbols: globalAddrs };
}

type ArchiveMemberKey = `${number}:${number}`;

interface TextBlock {
  objectIndex: number;
  blockIndex: number;
  start: number;
  end: number;
  names: Set<string>;
}

type BlockKey = `${number}:${number}`;

function gcText(objects: ObjectFile[], entryName: string): ObjectFile[] {
  const blocksByObject = objects.map((obj, objectIndex) => textBlocks(obj, objectIndex));
  const byGlobalName = new Map<string, TextBlock>();
  for (const blocks of blocksByObject) {
    for (const block of blocks) {
      for (const name of block.names) byGlobalName.set(name, block);
    }
  }

  const byKey = new Map<BlockKey, TextBlock>();
  for (const blocks of blocksByObject) {
    for (const block of blocks) byKey.set(blockKey(block), block);
  }

  const reachable = new Set<BlockKey>();
  const pending: TextBlock[] = [];
  const addBlock = (block: TextBlock | undefined): void => {
    if (!block) return;
    const key = blockKey(block);
    if (reachable.has(key)) return;
    reachable.add(key);
    pending.push(block);
  };

  addBlock(byGlobalName.get(entryName));

  for (let objectIndex = 0; objectIndex < objects.length; objectIndex++) {
    const obj = objects[objectIndex]!;
    for (const reloc of obj.relocs) {
      if (reloc.section !== 'data') continue;
      addReferencedBlock(
        objects,
        blocksByObject,
        byGlobalName,
        objectIndex,
        reloc.symbol,
        addBlock,
      );
    }
  }

  while (pending.length > 0) {
    const block = pending.pop()!;
    const obj = objects[block.objectIndex]!;
    for (const reloc of obj.relocs) {
      if (reloc.section !== 'text') continue;
      if (reloc.offset < block.start || reloc.offset >= block.end) continue;
      addReferencedBlock(
        objects,
        blocksByObject,
        byGlobalName,
        block.objectIndex,
        reloc.symbol,
        addBlock,
      );
    }
  }

  return objects.map((obj, objectIndex) => {
    const blocks = blocksByObject[objectIndex]!;
    if (blocks.length === 0) return obj;
    const keep = blocks.filter((block) => reachable.has(blockKey(block)));
    if (keep.length === blocks.length) return obj;
    return pruneObjectText(obj, keep);
  });
}

function textBlocks(obj: ObjectFile, objectIndex: number): TextBlock[] {
  const starts = obj.symbols
    .filter((sym) => sym.section === 'text' && sym.binding === 'global')
    .sort((a, b) => a.value - b.value);
  if (starts.length === 0) return [];
  const blocks: TextBlock[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!.value;
    const end = i + 1 < starts.length ? starts[i + 1]!.value : obj.text.length;
    const names = new Set(starts.filter((sym) => sym.value === start).map((sym) => sym.name));
    if (blocks.length > 0 && blocks[blocks.length - 1]!.start === start) continue;
    blocks.push({ objectIndex, blockIndex: blocks.length, start, end, names });
  }
  return blocks;
}

function addReferencedBlock(
  objects: ObjectFile[],
  blocksByObject: TextBlock[][],
  byGlobalName: Map<string, TextBlock>,
  objectIndex: number,
  symbolIndex: number,
  addBlock: (block: TextBlock | undefined) => void,
): void {
  const sym = objects[objectIndex]!.symbols[symbolIndex]!;
  if (sym.section === 'undef') {
    addBlock(byGlobalName.get(sym.name));
    return;
  }
  if (sym.section !== 'text') return;
  const localBlock = blocksByObject[objectIndex]!.find(
    (block) => sym.value >= block.start && sym.value < block.end,
  );
  addBlock(localBlock);
}

function pruneObjectText(obj: ObjectFile, keep: TextBlock[]): ObjectFile {
  const ranges = [...keep].sort((a, b) => a.start - b.start);
  const offsetMap = new Map<number, number>();
  let textSize = 0;
  for (const range of ranges) {
    for (let old = range.start; old < range.end; old++)
      offsetMap.set(old, textSize + old - range.start);
    textSize += range.end - range.start;
  }
  const text = new Uint8Array(textSize);
  let cursor = 0;
  for (const range of ranges) {
    text.set(obj.text.subarray(range.start, range.end), cursor);
    cursor += range.end - range.start;
  }

  const oldToNew = new Map<number, number>();
  const symbols = obj.symbols.flatMap((sym, index) => {
    if (sym.section !== 'text') {
      oldToNew.set(index, oldToNew.size);
      return [sym];
    }
    const value = offsetMap.get(sym.value);
    if (value === undefined) return [];
    oldToNew.set(index, oldToNew.size);
    return [{ ...sym, value }];
  });

  const relocs = obj.relocs.flatMap((reloc) => {
    const symbol = oldToNew.get(reloc.symbol);
    if (symbol === undefined) return [];
    if (reloc.section === 'data') return [{ ...reloc, symbol }];
    const offset = offsetMap.get(reloc.offset);
    if (offset === undefined) return [];
    return [{ ...reloc, offset, symbol }];
  });

  return { ...obj, text, symbols, relocs };
}

function blockKey(block: TextBlock): BlockKey {
  return `${block.objectIndex}:${block.blockIndex}`;
}

// Flatten a linked image into the guest's loadable header format: a 12-byte
// header (magic, entry, memSize) followed by the contiguous text+data image
// loaded at `base`. The bss tail is left to the loader to zero-fill.
export function flattenGuestExecutable(
  linked: LinkedObjects,
  base: number,
  magic: number,
): Uint8Array {
  const segments = linked.executable.segments;
  let fileEnd = base;
  let memEnd = base;
  for (const seg of segments) {
    fileEnd = Math.max(fileEnd, seg.vaddr + seg.data.length);
    memEnd = Math.max(memEnd, seg.vaddr + seg.memSize);
  }
  const fileLength = fileEnd - base;
  const out = new Uint8Array(12 + fileLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, magic, true);
  dv.setUint32(4, linked.entry, true);
  dv.setUint32(8, memEnd - base, true);
  for (const seg of segments) out.set(seg.data, 12 + (seg.vaddr - base));
  return out;
}

export function linkKernelImage(
  objects: ObjectFile[],
  archives: Archive[] = [],
  options: LinkObjectsOptions = {},
): KernelImage {
  const linked = linkObjects(objects, archives, {
    entry: options.entry ?? '_start',
    textOrigin: options.textOrigin ?? 0,
    gcSections: false,
  });
  const segments = linked.executable.segments;
  assertNoOverlap(segments);
  const end = Math.max(...segments.map((s) => s.vaddr + s.memSize));
  const flat = new Uint8Array(end);
  for (const s of segments) flat.set(s.data, s.vaddr);
  return {
    entry: linked.entry,
    symbols: linked.symbols,
    segments,
    flat,
  };
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
