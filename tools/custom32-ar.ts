#!/usr/bin/env node

// custom32-ar: create and inspect static archives.
//
// Usage:
//   custom32-ar rc archive.a obj1.o obj2.o ...   create/replace an archive
//   custom32-ar t  archive.a                      list members
//   custom32-ar x  archive.a [member ...]         extract members
//
// Member names are the object file basenames. Order is preserved.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { type Archive, encodeArchive, parseArchive } from '../src/formats/archive.ts';

function fail(message: string): never {
  console.error(`custom32-ar: ${message}`);
  process.exit(1);
}

function main(argv: string[]): void {
  const op = argv[0];
  const archivePath = argv[1];
  if (op === undefined || op === '-h' || op === '--help') {
    console.log('usage: custom32-ar rc|t|x archive.a [members...]');
    return;
  }
  if (archivePath === undefined) fail('missing archive path');
  const mode = op.replace(/^-/, '');

  if (mode.includes('r') || mode.includes('c')) {
    const members = argv.slice(2).map((path) => ({
      name: basename(path),
      data: new Uint8Array(readFileSync(path)),
    }));
    writeFileSync(archivePath, encodeArchive({ members }));
    return;
  }

  const archive: Archive = parseArchive(new Uint8Array(readFileSync(archivePath)));
  if (mode.includes('t')) {
    for (const member of archive.members) console.log(member.name);
    return;
  }
  if (mode.includes('x')) {
    const wanted = new Set(argv.slice(2));
    for (const member of archive.members) {
      if (wanted.size > 0 && !wanted.has(member.name)) continue;
      writeFileSync(member.name, member.data);
    }
    return;
  }
  fail(`unknown operation: ${op}`);
}

main(process.argv.slice(2));
