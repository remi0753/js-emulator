// A minimal C-style include preprocessor for the guest toolchain.
//
// It supports `#include "name"` with filename-based deduplication (so ordinary
// `#ifndef`/`#define`/`#endif` include guards are unnecessary -- they are
// stripped along with any other `#`-directive). It deliberately does NOT
// implement object-like or function-like macros: shared compile-time constants
// flow through the `CFG_*` token substitution in src/v3/guest-kernel.ts, which
// remains the single source of truth for the memory layout and ISA values.
//
// This is the "equivalent include mechanism" the v4 roadmap asks for: it lets
// several C files share one header of struct definitions, function prototypes,
// and `extern` declarations without duplicating them.

// Resolves an include name (the text between the quotes) to its source, or
// returns undefined if the header is unknown.
export type IncludeResolver = (name: string) => string | undefined;

const INCLUDE_RE = /^#\s*include\s+"([^"]+)"\s*$/;

export function preprocess(source: string, resolve?: IncludeResolver): string {
  const included = new Set<string>();

  const expand = (text: string, origin: string): string => {
    const out: string[] = [];
    for (const raw of text.split('\n')) {
      const trimmed = raw.trim();
      const match = INCLUDE_RE.exec(trimmed);
      if (match) {
        const name = match[1]!;
        if (included.has(name)) continue; // already pulled in: dedupe like a guard
        included.add(name);
        const body = resolve?.(name);
        if (body === undefined) {
          throw new Error(`preprocess: cannot resolve include "${name}" (in ${origin})`);
        }
        out.push(expand(body, name));
        continue;
      }
      // Drop guard/conditional directives we don't interpret. Includes are the
      // only directive with meaning here; everything else (#ifndef/#define/
      // #endif/#pragma) is redundant given filename-based dedup.
      if (trimmed.startsWith('#')) continue;
      out.push(raw);
    }
    return out.join('\n');
  };

  return expand(source, '<root>');
}
