import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { renderGuestConfigHeader } from '../src/v3/config.ts';

test('generated C configuration header is current', () => {
  const path = new URL('../src/v3/generated-config.h', import.meta.url);
  assert.equal(
    readFileSync(path, 'utf8'),
    renderGuestConfigHeader(),
    'run npm run gen:c-headers after changing guest configuration',
  );
});
