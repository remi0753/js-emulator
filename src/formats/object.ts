// Relocatable object file format for the custom32 toolchain (Phase 29).
//
// An object holds three sections (text, data, bss), a symbol table, and a
// relocation table. Unlike the source-level linker in `toolchain/linker.ts`
// (which re-assembles assembly text at a fixed origin), this format carries
// fully assembled bytes plus relocations, so the linker can place sections at
// any address, resolve cross-object references, and pull members from archives.
//
// Symbols are local (file-private), global (exported), or undefined (referenced
// here, defined elsewhere). Relocations name a symbol and patch a 32-bit field
// with `symbolAddress + addend` once layout is known. The on-disk form is a
// fixed header followed by the section bytes, the symbol table, the relocation
// table, and a string table, in that deterministic order.
//
// On-disk layout (little-endian):
//
//   header (36 bytes):
//     magic(u32) version(u32) nameOff(u32)
//     textSize(u32) dataSize(u32) bssSize(u32)
//     symCount(u32) relocCount(u32) strtabSize(u32)
//   text bytes (textSize)
//   data bytes (dataSize)
//   symbol table (symCount x 12): nameOff(u32) section(u8) binding(u8) pad(u16) value(u32)
//   reloc table  (relocCount x 16): section(u8) type(u8) pad(u16) offset(u32) symbol(u32) addend(i32)
//   string table (strtabSize): NUL-separated, offset 0 is the empty string

export const OBJ_MAGIC = 0x314a424f; // "OBJ1" (little-endian)
export const OBJ_VERSION = 1;

// Which section a symbol/relocation belongs to. `undef` symbols are referenced
// but defined in another object; `abs` symbols carry a fixed value.
export type ObjSection = 'undef' | 'text' | 'data' | 'bss' | 'abs';
export type RelocSection = 'text' | 'data';
export type SymBinding = 'local' | 'global';
export type RelocType = 'abs32';

export interface ObjSymbol {
  name: string;
  section: ObjSection;
  binding: SymBinding;
  // Offset within the named section, or the literal value for `abs` symbols.
  value: number;
}

export interface ObjReloc {
  section: RelocSection; // section whose bytes are patched
  offset: number; // byte offset within that section
  symbol: number; // index into the object's symbol table
  type: RelocType;
  addend: number; // added to the resolved symbol address
}

export interface ObjectFile {
  name: string; // module name, used for diagnostics and archive members
  text: Uint8Array;
  data: Uint8Array;
  bssSize: number;
  symbols: ObjSymbol[];
  relocs: ObjReloc[];
}

const HEADER_SIZE = 36;
const SYM_SIZE = 12;
const RELOC_SIZE = 16;

const SECTION_CODES: Record<ObjSection, number> = {
  undef: 0,
  text: 1,
  data: 2,
  bss: 3,
  abs: 4,
};
const SECTION_NAMES = ['undef', 'text', 'data', 'bss', 'abs'] as const;
const BINDING_CODES: Record<SymBinding, number> = { local: 0, global: 1 };
const RELOC_CODES: Record<RelocType, number> = { abs32: 1 };

// Incrementally builds a NUL-separated string table, deduplicating entries.
// Offset 0 is always the empty string.
class StringTable {
  private readonly bytes: number[] = [0];
  private readonly offsets = new Map<string, number>([['', 0]]);

  intern(value: string): number {
    const existing = this.offsets.get(value);
    if (existing !== undefined) return existing;
    const offset = this.bytes.length;
    for (const byte of new TextEncoder().encode(value)) this.bytes.push(byte);
    this.bytes.push(0);
    this.offsets.set(value, offset);
    return offset;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function readCString(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

export function encodeObject(obj: ObjectFile): Uint8Array {
  const strtab = new StringTable();
  const nameOff = strtab.intern(obj.name);
  const symEntries = obj.symbols.map((sym) => ({ sym, nameOff: strtab.intern(sym.name) }));
  const strtabBytes = strtab.toBytes();

  const total =
    HEADER_SIZE +
    obj.text.length +
    obj.data.length +
    obj.symbols.length * SYM_SIZE +
    obj.relocs.length * RELOC_SIZE +
    strtabBytes.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  dv.setUint32(0, OBJ_MAGIC, true);
  dv.setUint32(4, OBJ_VERSION, true);
  dv.setUint32(8, nameOff, true);
  dv.setUint32(12, obj.text.length, true);
  dv.setUint32(16, obj.data.length, true);
  dv.setUint32(20, obj.bssSize, true);
  dv.setUint32(24, obj.symbols.length, true);
  dv.setUint32(28, obj.relocs.length, true);
  dv.setUint32(32, strtabBytes.length, true);

  let off = HEADER_SIZE;
  buf.set(obj.text, off);
  off += obj.text.length;
  buf.set(obj.data, off);
  off += obj.data.length;

  for (const { sym, nameOff: symName } of symEntries) {
    dv.setUint32(off, symName, true);
    dv.setUint8(off + 4, SECTION_CODES[sym.section]);
    dv.setUint8(off + 5, BINDING_CODES[sym.binding]);
    dv.setUint16(off + 6, 0, true);
    dv.setUint32(off + 8, sym.value >>> 0, true);
    off += SYM_SIZE;
  }

  for (const reloc of obj.relocs) {
    dv.setUint8(off, SECTION_CODES[reloc.section]);
    dv.setUint8(off + 1, RELOC_CODES[reloc.type]);
    dv.setUint16(off + 2, 0, true);
    dv.setUint32(off + 4, reloc.offset >>> 0, true);
    dv.setUint32(off + 8, reloc.symbol >>> 0, true);
    dv.setInt32(off + 12, reloc.addend | 0, true);
    off += RELOC_SIZE;
  }

  buf.set(strtabBytes, off);
  return buf;
}

export function parseObject(bytes: Uint8Array): ObjectFile {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_SIZE || dv.getUint32(0, true) !== OBJ_MAGIC) {
    throw new Error('bad object: magic mismatch');
  }
  const version = dv.getUint32(4, true);
  if (version !== OBJ_VERSION) {
    throw new Error(`bad object: unsupported version ${version}`);
  }
  const nameOff = dv.getUint32(8, true);
  const textSize = dv.getUint32(12, true);
  const dataSize = dv.getUint32(16, true);
  const bssSize = dv.getUint32(20, true);
  const symCount = dv.getUint32(24, true);
  const relocCount = dv.getUint32(28, true);
  const strtabSize = dv.getUint32(32, true);

  let off = HEADER_SIZE;
  const text = bytes.subarray(off, off + textSize);
  off += textSize;
  const data = bytes.subarray(off, off + dataSize);
  off += dataSize;
  const symStart = off;
  off += symCount * SYM_SIZE;
  const relocStart = off;
  off += relocCount * RELOC_SIZE;
  const strtab = bytes.subarray(off, off + strtabSize);
  if (off + strtabSize > bytes.length) {
    throw new Error('bad object: truncated');
  }

  const symbols: ObjSymbol[] = [];
  for (let i = 0; i < symCount; i++) {
    const base = symStart + i * SYM_SIZE;
    const name = readCString(strtab, dv.getUint32(base, true));
    const section = SECTION_NAMES[dv.getUint8(base + 4)];
    if (section === undefined) throw new Error('bad object: invalid symbol section');
    symbols.push({
      name,
      section,
      binding: dv.getUint8(base + 5) === 1 ? 'global' : 'local',
      value: dv.getUint32(base + 8, true),
    });
  }

  const relocs: ObjReloc[] = [];
  for (let i = 0; i < relocCount; i++) {
    const base = relocStart + i * RELOC_SIZE;
    const sectionCode = dv.getUint8(base);
    const section = SECTION_NAMES[sectionCode];
    if (section !== 'text' && section !== 'data') {
      throw new Error('bad object: invalid relocation section');
    }
    if (dv.getUint8(base + 1) !== RELOC_CODES.abs32) {
      throw new Error('bad object: unknown relocation type');
    }
    relocs.push({
      section,
      type: 'abs32',
      offset: dv.getUint32(base + 4, true),
      symbol: dv.getUint32(base + 8, true),
      addend: dv.getInt32(base + 12, true),
    });
  }

  return { name: readCString(strtab, nameOff), text, data, bssSize, symbols, relocs };
}

export function isObject(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0 === OBJ_MAGIC
  );
}
