// Build the maintained guest OS disk image.
//
// The output contains the filesystem, compiled userland, boot manifest, and a
// raw guest-kernel region. `npm run boot` subsequently loads the kernel only
// from this image; it does not compile or inject a separate kernel artifact.
//
// Usage: node tools/mkimg.ts [out=disk.img]

import { writeFileSync } from 'node:fs';

import { decodeBootBlock } from '../src/formats/bootblock.ts';
import { buildGuestDiskImage } from '../src/v3/guest-kernel.ts';

const out = process.argv[2] ?? 'disk.img';
const image = buildGuestDiskImage();
const manifest = decodeBootBlock(image.subarray(0, 512));
writeFileSync(out, image);

console.log(`built ${out} (${image.length} bytes, ${image.length / 512} blocks)`);
console.log(
  `installed kernel: blocks ${manifest.kernelStart}..${manifest.kernelStart + manifest.kernelBlocks - 1}, entry 0x${manifest.kernelEntry.toString(16)}`,
);
console.log(`boot it with: npm run boot -- ${out}`);
