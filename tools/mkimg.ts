// Build the maintained guest OS disk image.
//
// The output contains the filesystem, compiled userland, boot manifest, and a
// raw guest-kernel region. `npm run boot` subsequently loads the kernel only
// from this image; it does not compile or inject a separate kernel artifact.
//
// Usage: node tools/mkimg.ts [--dev] [--blocks N] [out=disk.img]

import { writeFileSync } from 'node:fs';

import { decodeBootBlock } from '../src/formats/bootblock.ts';
import { buildGuestDiskImage, GUEST_DEVELOPMENT_FS_BLOCKS } from '../src/v3/guest-kernel.ts';

let out = 'disk.img';
let fsBlocks: number | undefined;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  if (arg === '--dev') fsBlocks = GUEST_DEVELOPMENT_FS_BLOCKS;
  else if (arg === '--blocks') fsBlocks = Number.parseInt(process.argv[++i] ?? '', 10);
  else out = arg;
}
if (fsBlocks !== undefined && (!Number.isFinite(fsBlocks) || fsBlocks < 2048)) {
  throw new Error('--blocks must be at least 2048');
}

const image = buildGuestDiskImage({ fsBlocks });
const manifest = decodeBootBlock(image.subarray(0, 512));
writeFileSync(out, image);

console.log(`built ${out} (${image.length} bytes, ${image.length / 512} blocks)`);
console.log(
  `installed kernel: blocks ${manifest.kernelStart}..${manifest.kernelStart + manifest.kernelBlocks - 1}, entry 0x${manifest.kernelEntry.toString(16)}`,
);
console.log(`boot it with: npm run boot -- ${out}`);
