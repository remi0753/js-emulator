// Boot the maintained guest OS from an installed disk image and connect its TTY
// to the host terminal.
//
// Ctrl-C and Ctrl-Z are delivered to the guest terminal. Ctrl-D is guest EOF.
// Ctrl-] exits the VM monitor. Disk changes are written back on clean exit.
//
// Usage: node tools/boot.ts [image=disk.img]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { bootGuestDiskImage } from '../src/v3/boot.ts';

const imagePath = process.argv[2] ?? 'disk.img';
if (!existsSync(imagePath)) {
  console.error(`no image at ${imagePath} — build one first: npm run build:img`);
  process.exit(1);
}

const diskImage = new Uint8Array(readFileSync(imagePath));
const { machine, manifest } = bootGuestDiskImage(diskImage, {
  consoleSink: (text) => process.stdout.write(text),
});

const RUN_SLICE = 250_000;
let pumpScheduled = false;
let finished = false;
let stdinEnded = false;

function restoreTerminal(): void {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
}

function saveDisk(): void {
  writeFileSync(imagePath, machine.disk.data);
}

function finish(code: number, persist = true): never {
  if (!finished) {
    finished = true;
    restoreTerminal();
    if (persist) saveDisk();
  }
  process.exit(code);
}

function guestExited(): boolean {
  return machine.console.output.endsWith('kernel: all processes exited\n');
}

function schedulePump(): void {
  if (finished || pumpScheduled) return;
  pumpScheduled = true;
  setImmediate(pump);
}

function pump(): void {
  pumpScheduled = false;
  if (finished) return;
  try {
    const result = machine.run(RUN_SLICE);
    if (machine.power.poweredOff || guestExited()) finish(0);
    if (result.reason !== 'halt') schedulePump();
    else if (stdinEnded) finish(0);
  } catch (error) {
    restoreTerminal();
    console.error(error);
    finish(1, false);
  }
}

function feedHostBytes(chunk: Buffer): void {
  let text = '';
  for (const byte of chunk) {
    if (byte === 0x1d) finish(0); // Ctrl-] leaves the VM monitor.
    text += String.fromCharCode(byte === 13 ? 10 : byte);
  }
  if (text.length > 0) machine.keyboard.feed(text);
  schedulePump();
}

process.once('SIGTERM', () => finish(0));
process.once('SIGHUP', () => finish(0));
process.once('SIGINT', () => finish(0));
process.once('uncaughtException', (error) => {
  restoreTerminal();
  console.error(error);
  finish(1, false);
});

console.error(
  `[vm] booting ${imagePath}: kernel block ${manifest.kernelStart}, entry 0x${manifest.kernelEntry.toString(16)}`,
);

process.stdin.on('data', feedHostBytes);
process.stdin.on('end', () => {
  stdinEnded = true;
  machine.keyboard.close();
  schedulePump();
});
process.stdin.resume();

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  console.error('[vm] guest TTY attached; Ctrl-] exits the VM');
}

schedulePump();
