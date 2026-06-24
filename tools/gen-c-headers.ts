import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderGuestConfigHeader } from '../src/v3/config.ts';

const output = fileURLToPath(new URL('../src/v3/generated-config.h', import.meta.url));
writeFileSync(output, renderGuestConfigHeader());
console.log(`wrote ${output}`);
