// v2 Phase 4 demo: storage — block disk, on-disk filesystem, exec from disk.
//
// The kernel mounts a host-backed `disk.img` (created on first run, then
// persistent across runs). A guest `/bin/init`, loaded *from the filesystem*,
// opens `/etc/motd` and cats it to the console using open/read/write/close. The
// kernel then lists the root directory and saves the disk back to `disk.img`, so
// the file count grows each time you run it.
//
// Run: node demo/v2-fs.ts   (run twice to see persistence)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { assemble } from '../src/assembler.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';
import { LAYOUT } from '../src/v2/layout.ts';

const DISK_IMG = new URL('../disk.img', import.meta.url);

// A guest "cat /etc/motd": open the file, then read/write 16 bytes at a time.
const init = assemble(
  `
      MOV R0, 7            ; OPEN "/etc/motd", O_RDONLY
      MOV R1, path
      MOV R2, 0
      INT 0x80
      MOVR R5, R0          ; fd
    loop:
      MOV R0, 9            ; READ(fd, buf, 16)
      MOVR R1, R5
      MOV R2, buf
      MOV R3, 16
      INT 0x80
      MOV R7, 0
      CMP R0, R7
      JZ  done             ; 0 bytes -> EOF
      MOVR R6, R0          ; nread
      MOV R0, 1            ; WRITE(stdout, buf, nread)
      MOV R1, 1
      MOV R2, buf
      MOVR R3, R6
      INT 0x80
      JMP loop
    done:
      MOV R0, 8            ; CLOSE(fd)
      MOVR R1, R5
      INT 0x80
      MOV R0, 0            ; EXIT 0
      MOV R1, 0
      INT 0x80
    path:
      .string "/etc/motd"
    buf:
      .word 0
      .word 0
      .word 0
      .word 0
  `,
  LAYOUT.USER_TEXT,
).bytes;

const fresh = !existsSync(DISK_IMG);
const kernel = new Kernel({
  diskImage: fresh ? undefined : new Uint8Array(readFileSync(DISK_IMG)),
  log: (m) => console.log(`[kernel] ${m}`),
});

console.log(`=== v2 storage: block disk + filesystem ===`);
console.log(fresh ? 'no disk.img -> formatting a fresh disk\n' : 'mounted existing disk.img\n');

if (fresh) {
  kernel.fs.writeFile('/etc/motd', textBytes('Welcome to jscpu-os v2 - files on a real disk!\n'));
  kernel.install('/bin/init', init);
}

// A per-run counter stored on disk demonstrates persistence across runs.
const runs = readCounter(kernel, '/var/runs') + 1;
writeCounter(kernel, '/var/runs', runs);
console.log(`this is run #${runs}\n`);

// Boot init from the filesystem; it cats /etc/motd.
kernel.spawnFromFile('init', '/bin/init');
kernel.run();

console.log('\n=== ls / ===');
for (const e of kernel.fs.readdir(kernel.fs.namei('/'))) {
  const din = kernel.fs.readInode(e.inum);
  const kind = din.type === 1 ? 'dir ' : 'file';
  console.log(`  ${kind}  ${e.name.padEnd(10)} ${din.size} bytes`);
}

// Persist the disk so the next run mounts it.
writeFileSync(DISK_IMG, kernel.disk.data);
console.log('\nsaved disk.img');

function textBytes(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}
function readCounter(k: Kernel, path: string): number {
  const inum = k.fs.namei(path);
  if (inum === 0) return 0;
  return Number.parseInt(String.fromCharCode(...k.fs.readFile(inum)) || '0', 10);
}
function writeCounter(k: Kernel, path: string, n: number): void {
  k.fs.writeFile(path, textBytes(String(n)));
}
