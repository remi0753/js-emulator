// boot: boot a disk image to a shell (Phase 9).
//
// Reads disk.img, mounts its filesystem, and boots through the boot block in
// sector 0 — it does NOT install userland or hard-code init. The manifest names
// the program to run; the userland already lives on the disk. Build the image
// first with `node tools/mkimg.ts` (or `npm run build:img`).
//
// Usage: node tools/boot.ts [image=disk.img]

import { existsSync, readFileSync } from 'node:fs';

import { bootImage } from '../src/v2/boot.ts';

const imagePath = process.argv[2] ?? 'disk.img';
if (!existsSync(imagePath)) {
  console.error(`no image at ${imagePath} — build one first: node tools/mkimg.ts`);
  process.exit(1);
}

const kernel = bootImage(new Uint8Array(readFileSync(imagePath)), { quantum: 200, log: () => {} });

console.log(`=== booted ${imagePath} ===\n`);

if (process.stdin.isTTY) {
  // Interactive: feed keystrokes to the keyboard; run() resumes the blocked shell.
  kernel.run(); // first prompt, then blocks on stdin
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk: Buffer) => {
    for (const byte of chunk) {
      if (byte === 3) process.exit(0); // Ctrl-C
      if (byte === 4) {
        kernel.closeInput(); // Ctrl-D = EOF
        continue;
      }
      const ch = byte === 13 ? '\n' : String.fromCharCode(byte);
      process.stdout.write(ch);
      kernel.feedInput(ch);
    }
    kernel.run();
    if (!kernel.hasLiveProcesses) {
      process.stdin.setRawMode(false);
      process.exit(0);
    }
  });
} else {
  // Non-interactive: run a short scripted session and quit at EOF.
  const script = ['ls /', 'ls /bin', 'cat /README', 'echo booted from disk'];
  console.log('(no TTY -> scripted session)\n');
  kernel.feedInput(`${script.join('\n')}\n`);
  kernel.closeInput();
  kernel.run();
}
