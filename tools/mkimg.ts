// mkimg: build a bootable disk image (Phase 9).
//
// One command produces a self-describing disk.img: a formatted filesystem with
// the userland installed and a boot block (manifest) in sector 0. Boot it with
// `node tools/boot.ts` (or `npm run boot`) — no userland installation needed at
// boot time, because it already lives on the disk.
//
// Usage: node tools/mkimg.ts [out=disk.img]

import { writeFileSync } from 'node:fs';

import { buildDiskImage } from '../src/v2/boot.ts';

const out = process.argv[2] ?? 'disk.img';
const image = buildDiskImage();
writeFileSync(out, image);

console.log(`built ${out} (${image.length} bytes, ${image.length / 512} blocks)`);
console.log('boot it with: node tools/boot.ts');
