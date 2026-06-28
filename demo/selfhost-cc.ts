// End-to-end self-hosting demo: build a disk, install *all* of the C compiler's
// source onto the guest filesystem, boot the OS, and have the guest's own `cc`
// recompile the entire compiler into a fresh executable — then prove that
// guest-produced compiler works by using it to compile and run a program.
//
// Nothing here compiles C on the host after the disk is built: the host only
// stages source + prebuilt runtime support (crt/libc/i64), exactly the way a
// cross-compiler ships a target libc. Every compiler translation unit (the
// vendored chibicc frontend, the custom32 backend, the driver, the in-process
// linker, and the support helpers) is compiled by the guest `cc` inside the VM.
//
// Run: node demo/selfhost-cc.ts
//
// This is a long run: the guest compiles ~11 translation units and links ~1.5 MB
// of assembly with an interpreted CPU, so expect a multi-minute (tens of
// minutes) execution.

import { bootGuestDiskImage } from '../src/v3/boot.ts';
import {
  GUEST_BUILD_COMMAND,
  GUEST_REBUILT_CC_PATH,
  installChibiccToolchain,
} from '../src/v3/guest-chibicc.ts';
import { buildGuestDiskImage, GUEST_DEVELOPMENT_FS_BLOCKS } from '../src/v3/guest-kernel.ts';
import { DirectBlockDevice } from '../src/storage/direct-block-device.ts';
import { Fs } from '../src/storage/fs.ts';

// A budget large enough to boot, compile every compiler translation unit, and
// link the result. The interpreted CPU runs at a few million steps/second.
const BUILD_BUDGET = 80_000_000_000;
const USE_BUDGET = 12_000_000_000;

function mount(disk: Uint8Array): Fs {
  const fs = new Fs(new DirectBlockDevice(disk));
  fs.mount();
  return fs;
}

function readText(fs: Fs, path: string): string | undefined {
  const inum = fs.namei(path);
  if (!inum) return undefined;
  return new TextDecoder().decode(fs.readFile(inum));
}

function fileSize(fs: Fs, path: string): number {
  const inum = fs.namei(path);
  return inum ? fs.readFile(inum).length : 0;
}

// Run one shell session against the persistent disk image and return console
// output. The disk array is mutated in place, so later boots see earlier writes.
function runGuest(disk: Uint8Array, script: string, budget: number): string {
  let out = '';
  const { machine } = bootGuestDiskImage(disk, { consoleSink: (s) => (out += s) });
  machine.keyboard.feed(`${script}\n`);
  machine.keyboard.close();
  const result = machine.run(budget);
  out += `\n[guest stopped: ${result.reason}]\n`;
  return out;
}

console.log('[host] building development disk image…');
const disk = buildGuestDiskImage({ fsBlocks: GUEST_DEVELOPMENT_FS_BLOCKS });

console.log('[host] installing /bin/cc, headers, and the full compiler source tree…');
const fs = mount(disk);
installChibiccToolchain(fs, { installSources: true });

// A program for the *guest-produced* compiler to build, plus its link list.
fs.writeFile(
  '/selfhost/hello.c',
  new TextEncoder().encode(
    [
      '#include <stdio.h>',
      '#include <stdlib.h>',
      'int main(void) {',
      '  char *msg = malloc(8);',
      '  msg[0] = 79; msg[1] = 75; msg[2] = 0;', // "OK"
      '  printf("guest-built cc says %s (%d)\\n", msg, 6 * 7);',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
  ),
);
fs.writeFile(
  '/selfhost/hello.objs',
  new TextEncoder().encode(
    ['/usr/src/cc/crt.s', '/usr/src/cc/libc.s', '/usr/src/cc/i64rt.s', '/b/hello.s', ''].join('\n'),
  ),
);

console.log(`[host] installed source units under /usr/src/cc; libc.s ${fileSize(fs, '/usr/src/cc/libc.s')} bytes`);
console.log('');
console.log(`[guest] rebuilding the compiler from source: ${GUEST_BUILD_COMMAND}`);
console.log('[guest] (this is the long part — the guest compiles every translation unit)…');
const buildOut = runGuest(disk, GUEST_BUILD_COMMAND, BUILD_BUDGET);
process.stdout.write(buildOut);

const built = mount(disk);
const ccSize = fileSize(built, GUEST_REBUILT_CC_PATH);
if (!buildOut.includes('cc-build-done') || ccSize === 0) {
  console.error(`\n[FAIL] guest did not produce ${GUEST_REBUILT_CC_PATH} (size ${ccSize}).`);
  process.exit(1);
}
console.log(`\n[host] guest produced ${GUEST_REBUILT_CC_PATH}: ${ccSize} bytes ✅`);

console.log('');
console.log('[guest] using the guest-produced compiler to build and run a program…');
const useOut = runGuest(
  disk,
  [
    'mkdir /b',
    `${GUEST_REBUILT_CC_PATH} -S -o /b/hello.s /selfhost/hello.c`,
    `${GUEST_REBUILT_CC_PATH} -o /hello @/selfhost/hello.objs`,
    '/hello',
    'echo use-done',
  ].join('\n'),
  USE_BUDGET,
);
process.stdout.write(useOut);

if (!useOut.includes('guest-built cc says OK (42)')) {
  console.error('\n[FAIL] the guest-produced compiler did not build a working program.');
  process.exit(1);
}

void readText;
console.log('');
console.log('[host] ✅ E2E complete: the guest compiled the entire C compiler from');
console.log('       source into a new executable, and that executable compiled and');
console.log('       ran a program — all inside the VM, no host compilation after boot.');
