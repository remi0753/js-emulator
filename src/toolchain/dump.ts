// Human-readable dumper for custom32 object files and archives.
//
// `objdump`/`nm`/`ar t` rolled into one: it renders an object's sections,
// symbol table, and relocations, or an archive's members and the symbols each
// provides, so a failing link test can be inspected without decoding binary
// blobs by hand. Output is deterministic.

import { type Archive, isArchive, parseArchive } from '../formats/archive.ts';
import { isObject, type ObjectFile, parseObject } from '../formats/object.ts';

function hex(value: number, width = 8): string {
  return `0x${(value >>> 0).toString(16).padStart(width, '0')}`;
}

export function dumpObject(obj: ObjectFile): string {
  const lines: string[] = [];
  lines.push(`object: ${obj.name}`);
  lines.push('sections:');
  lines.push(`  text  size=${obj.text.length}`);
  lines.push(`  data  size=${obj.data.length}`);
  lines.push(`  bss   size=${obj.bssSize}`);

  lines.push(`symbols: ${obj.symbols.length}`);
  obj.symbols.forEach((sym, index) => {
    const binding = sym.binding === 'global' ? 'GLOBAL' : 'LOCAL ';
    const where = sym.section === 'undef' ? 'UND' : sym.section.toUpperCase().padEnd(4);
    const value = sym.section === 'undef' ? '         ' : hex(sym.value);
    lines.push(`  [${String(index).padStart(2)}] ${binding} ${where} ${value} ${sym.name}`);
  });

  lines.push(`relocations: ${obj.relocs.length}`);
  for (const reloc of obj.relocs) {
    const sym = obj.symbols[reloc.symbol];
    const addend =
      reloc.addend === 0 ? '' : reloc.addend > 0 ? `+${reloc.addend}` : `${reloc.addend}`;
    lines.push(
      `  ${reloc.section.padEnd(4)} ${hex(reloc.offset)} ${reloc.type} ${sym?.name ?? '?'}${addend}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function dumpArchive(archive: Archive): string {
  const lines: string[] = [];
  lines.push(`archive: ${archive.members.length} member(s)`);
  for (const member of archive.members) {
    const obj = parseObject(member.data);
    const provided = obj.symbols
      .filter((s) => s.binding === 'global' && s.section !== 'undef')
      .map((s) => s.name);
    lines.push(`  ${member.name} (${member.data.length} bytes)`);
    lines.push(`    provides: ${provided.length > 0 ? provided.join(', ') : '(none)'}`);
  }
  return `${lines.join('\n')}\n`;
}

// Dump whichever container `bytes` holds, detected by its magic.
export function dump(bytes: Uint8Array): string {
  if (isArchive(bytes)) return dumpArchive(parseArchive(bytes));
  if (isObject(bytes)) return dumpObject(parseObject(bytes));
  throw new Error('dump: unrecognized file (not an object or archive)');
}
