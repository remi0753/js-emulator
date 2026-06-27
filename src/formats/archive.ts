// Static archive format for the custom32 toolchain (Phase 29).
//
// An archive is an ordered collection of named members (each member is the raw
// bytes of an object file). It is the `.a` equivalent of a Unix `ar` library:
// the linker treats each member as an object it may or may not pull in,
// depending on whether the member defines a symbol still undefined at link
// time. Member order is preserved exactly so output is deterministic.
//
// On-disk layout (little-endian):
//
//   header (8 bytes): magic(u32) memberCount(u32)
//   directory (memberCount x 12): nameOff(u32) dataOff(u32) dataSize(u32)
//   string table: NUL-separated member names, offset 0 is the empty string
//   member blobs, each at its `dataOff` (absolute offset from the archive start)

export const AR_MAGIC = 0x31524a41; // "AJR1" (little-endian)

export interface ArchiveMember {
  name: string;
  data: Uint8Array;
}

export interface Archive {
  members: ArchiveMember[];
}

const HEADER_SIZE = 8;
const DIR_ENTRY_SIZE = 12;

export function encodeArchive(archive: Archive): Uint8Array {
  const encoder = new TextEncoder();
  const n = archive.members.length;
  const dirSize = n * DIR_ENTRY_SIZE;
  const strtabBase = HEADER_SIZE + dirSize;
  // String table: offset 0 is the empty string, then each member name. Stored
  // name offsets are absolute (from the archive start) so the reader needs no
  // section base.
  const strBytes: number[] = [0];
  const nameOffsets: number[] = [];
  for (const member of archive.members) {
    nameOffsets.push(strtabBase + strBytes.length);
    for (const byte of encoder.encode(member.name)) strBytes.push(byte);
    strBytes.push(0);
  }
  const dataStart = HEADER_SIZE + dirSize + strBytes.length;
  let dataSize = 0;
  for (const member of archive.members) dataSize += member.data.length;

  const buf = new Uint8Array(dataStart + dataSize);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, AR_MAGIC, true);
  dv.setUint32(4, n, true);

  let dirOff = HEADER_SIZE;
  let blobOff = dataStart;
  for (let i = 0; i < n; i++) {
    const member = archive.members[i]!;
    dv.setUint32(dirOff, nameOffsets[i]!, true);
    dv.setUint32(dirOff + 4, blobOff, true);
    dv.setUint32(dirOff + 8, member.data.length, true);
    buf.set(member.data, blobOff);
    dirOff += DIR_ENTRY_SIZE;
    blobOff += member.data.length;
  }
  buf.set(Uint8Array.from(strBytes), HEADER_SIZE + dirSize);
  return buf;
}

export function parseArchive(bytes: Uint8Array): Archive {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_SIZE || dv.getUint32(0, true) !== AR_MAGIC) {
    throw new Error('bad archive: magic mismatch');
  }
  const n = dv.getUint32(4, true);
  const decoder = new TextDecoder();
  const members: ArchiveMember[] = [];
  for (let i = 0; i < n; i++) {
    const dirOff = HEADER_SIZE + i * DIR_ENTRY_SIZE;
    const nameOff = dv.getUint32(dirOff, true);
    const dataOff = dv.getUint32(dirOff + 4, true);
    const dataSize = dv.getUint32(dirOff + 8, true);
    if (dataOff + dataSize > bytes.length) throw new Error('bad archive: member out of range');
    let end = nameOff;
    while (end < bytes.length && bytes[end] !== 0) end++;
    members.push({
      name: decoder.decode(bytes.subarray(nameOff, end)),
      data: bytes.subarray(dataOff, dataOff + dataSize),
    });
  }
  return { members };
}

export function isArchive(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0 === AR_MAGIC
  );
}
