import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('../src/', import.meta.url);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (extname(entry.name) === '.ts') out.push(path);
  }
  return out;
}

function imports(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1]!,
  );
}

function assertNoImports(area: string, forbidden: RegExp): void {
  const rootPath = new URL(area, ROOT).pathname;
  const violations = sourceFiles(rootPath).flatMap((path) =>
    imports(path)
      .filter((specifier) => forbidden.test(specifier))
      .map((specifier) => `${relative(new URL('.', ROOT).pathname, path)} -> ${specifier}`),
  );
  assert.deepEqual(violations, []);
}

test('layering: VM does not depend on OS or toolchain code', () => {
  assertNoImports('vm/', /(?:^|\/)(?:v2|v3|kernel|toolchain)(?:\/|$)/);
});

test('layering: shared toolchain does not depend on an OS generation', () => {
  assertNoImports('toolchain/', /(?:^|\/)(?:v1|v2|v3)(?:\/|$)/);
});

test('layering: v3 does not reuse implementation from v2', () => {
  assertNoImports('v3/', /(?:^|\/)v2(?:\/|$)/);
});
