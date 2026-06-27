#!/usr/bin/env node
// custom32-objdump: dump an object file or archive in readable form.
//
// Usage: custom32-objdump file...

import { readFileSync } from 'node:fs';

import { dump } from '../src/toolchain/dump.ts';

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log('usage: custom32-objdump file...');
    return;
  }
  for (const path of argv) {
    if (argv.length > 1) console.log(`== ${path} ==`);
    try {
      process.stdout.write(dump(new Uint8Array(readFileSync(path))));
    } catch (error) {
      console.error(`custom32-objdump: ${path}: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

main(process.argv.slice(2));
