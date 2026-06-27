// chibicc-derived custom32 C compiler: top-level driver.
//
// Pipeline (mirrors chibicc's main.c): preprocess -> tokenize -> parse -> type
// -> custom32 codegen. `compile()` returns assembly text; `compileObject()`
// assembles it into a relocatable object with the project's `as.ts`, so chibicc
// output links through the same Phase 29 object pipeline as hand-written
// assembly and bootstrap-compiled C.
//
// See ./PROVENANCE.md for what is ported from chibicc and what is the custom32
// backend slice (Phase 31).

import type { ObjectFile } from '../../formats/object.ts';
import { assembleObject } from '../as.ts';
import { generate } from './codegen.ts';
import { type Program, parse } from './parse.ts';
import { preprocess } from './preprocess.ts';
import { addType } from './type.ts';

export interface CompileOptions {
  // Object file name (diagnostics / dump output).
  name?: string;
}

// Parse and type-check a translation unit into a typed program.
function frontend(source: string): Program {
  const program = parse(preprocess(source));
  for (const obj of program.objects) {
    if (obj.isFunction && obj.bodyNode) addType(obj.bodyNode);
  }
  return program;
}

// Compile a C translation unit to custom32 assembly text.
export function compile(source: string): string {
  return generate(frontend(source));
}

// Compile a C translation unit straight to a relocatable object file. The unit
// carries no startup code or runtime helpers; link it with `crt0Object()` (from
// ../cc.ts) the same way bootstrap-compiled objects are.
export function compileObject(source: string, options: CompileOptions = {}): ObjectFile {
  return assembleObject(compile(source), options.name ?? 'a.o');
}

export { CodegenError } from './codegen.ts';
export { ParseError } from './parse.ts';
export { PreprocessError } from './preprocess.ts';
export { TokenizeError } from './tokenize.ts';
