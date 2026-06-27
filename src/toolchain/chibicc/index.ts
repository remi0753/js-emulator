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
import { type IncludeResolver, preprocess } from './preprocess.ts';
import { addType } from './type.ts';

export interface CompileOptions {
  // Object file name (diagnostics / dump output).
  name?: string;
  // Resolves `#include` directives to header text. Without it, `#include`
  // is rejected.
  resolveInclude?: IncludeResolver;
}

const BUILTIN_INCLUDES = new Map<string, string>([
  [
    'stdarg.h',
    `#ifndef __CUSTOM32_STDARG_H
#define __CUSTOM32_STDARG_H
typedef char *va_list;
#define va_start(ap, last) __builtin_va_start(ap, last)
#define va_arg(ap, ty) __builtin_va_arg(ap, ty)
#define va_end(ap) ((void)0)
#endif
`,
  ],
]);

function resolveIncludeWithBuiltins(
  resolver: IncludeResolver | undefined,
): IncludeResolver | undefined {
  return (name, isAngle) => {
    const resolved = resolver?.(name, isAngle);
    if (resolved) return resolved;
    const builtin = BUILTIN_INCLUDES.get(name);
    return builtin === undefined ? undefined : { path: `<${name}>`, text: builtin };
  };
}

// Parse and type-check a translation unit into a typed program.
function frontend(source: string, options: CompileOptions = {}): Program {
  const program = parse(preprocess(source, resolveIncludeWithBuiltins(options.resolveInclude)));
  for (const obj of program.objects) {
    if (obj.isFunction && obj.bodyNode) addType(obj.bodyNode);
  }
  return program;
}

// Compile a C translation unit to custom32 assembly text.
export function compile(source: string, options: CompileOptions = {}): string {
  return generate(frontend(source, options));
}

// Compile a C translation unit straight to a relocatable object file. The unit
// carries no startup code or runtime helpers; link it with `crt0Object()` (from
// ../cc.ts) the same way bootstrap-compiled objects are.
export function compileObject(source: string, options: CompileOptions = {}): ObjectFile {
  return assembleObject(compile(source, options), options.name ?? 'a.o');
}

export { CodegenError } from './codegen.ts';
export { ParseError } from './parse.ts';
export { type IncludeResolver, PreprocessError } from './preprocess.ts';
export { TokenizeError } from './tokenize.ts';
