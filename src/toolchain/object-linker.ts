// Object linker: relocatable objects + archives -> a loadable executable.
//
// This is the object-file counterpart to the source-level `linker.ts`. It takes
// fully assembled `ObjectFile`s (from `as.ts`) plus static archives, resolves
// global/undefined symbols, pulls archive members on demand, lays out the
// text/data/bss sections at concrete addresses, applies relocations, and emits
// the shared `Executable` format. A thin helper flattens the result into the
// guest's loadable header format.
//
// Layout: all text sections first (at `textOrigin`), then data, then bss, each
// object's sections concatenated in input order (then archive pull order) and
// padded to a 4-byte boundary. Output is deterministic for a given input order.

import type { Archive } from '../formats/archive.ts';
import { type Executable, SEG } from '../formats/executable.ts';
import { type ObjectFile, parseObject } from '../formats/object.ts';

export interface LinkObjectsOptions {
  textOrigin?: number;
  entry?: string;
}

export interface LinkedObjects {
  executable: Executable;
  entry: number;
  symbols: Map<string, number>; // global symbol name -> resolved address
}

const DEFAULT_TEXT_ORIGIN = 0x1000;

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

  // Layout: text, then data, then bss.
  const placed: PlacedObject[] = [];
  let textCursor = textOrigin;
  for (const obj of loaded) {
    placed.push({ obj, textBase: textCursor, dataBase: 0, bssBase: 0 });
    textCursor = align(textCursor + obj.text.length, 4);
  }
  const textEnd = textCursor;
  let dataCursor = textEnd;
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
      }
    });
  }

  // Compose section bytes and apply relocations.
  const text = new Uint8Array(textEnd - textOrigin);
  const data = new Uint8Array(dataEnd - textEnd);
  for (const p of placed) {
    text.set(p.obj.text, p.textBase - textOrigin);
    data.set(p.obj.data, p.dataBase - textEnd);
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
      else writeWord(data, p.dataBase - textEnd + reloc.offset, value);
    }
  }

  const entry = globalAddrs.get(entryName);
  if (entry === undefined) throw new Error(`link: entry symbol not found: ${entryName}`);

  const executable: Executable = {
    entry,
    segments: [
      { vaddr: textOrigin, data: text, memSize: text.length, flags: SEG.R | SEG.X },
      { vaddr: textEnd, data, memSize: memEnd - textEnd, flags: SEG.R | SEG.W },
    ],
  };
  return { executable, entry, symbols: globalAddrs };
}

type ArchiveMemberKey = `${number}:${number}`;

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
