#!/usr/bin/env node

// custom32-as: assemble a single translation unit into a relocatable object.
//
// Usage: custom32-as [-o out.o] input.s
//
// With no -o the output is the input path with its extension replaced by `.o`.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { encodeObject } from '../src/formats/object.ts';
import { assembleObject } from '../src/toolchain/as.ts';

function fail(message: string): never {
  console.error(`custom32-as: ${message}`);
  process.exit(1);
}

function main(argv: string[]): void {
  let out: string | undefined;
  let input: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-o') {
      out = argv[++i];
      if (out === undefined) fail('-o requires an argument');
    } else if (arg === '-h' || arg === '--help') {
      console.log('usage: custom32-as [-o out.o] input.s');
      return;
    } else if (arg.startsWith('-')) {
      fail(`unknown option: ${arg}`);
    } else if (input === undefined) {
      input = arg;
    } else {
      fail('only one input file is supported');
    }
  }
  if (input === undefined) fail('no input file');

  const source = readFileSync(input, 'utf8');
  const moduleName = basename(input).replace(/\.[^.]+$/, '.o');
  const outPath = out ?? input.replace(new RegExp(`${extname(input)}$`), '.o');
  const obj = assembleObject(source, moduleName);
  writeFileSync(outPath, encodeObject(obj));
}

main(process.argv.slice(2));
