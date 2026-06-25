import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeBootBlock, makeBootBlock } from '../formats/bootblock.ts';
import { BLOCK_SIZE } from '../storage/block.ts';
import { Fs } from '../storage/fs.ts';
import { PortBlockDevice } from '../storage/port-block-device.ts';
import { type CompiledObject, compileC } from '../toolchain/c.ts';
import { type KernelImage, linkExecutable, linkKernelImage } from '../toolchain/linker.ts';
import { preprocess } from '../toolchain/preprocess.ts';
import { BlockDisk } from '../vm/custom32/devices/disk.ts';
import { PORT } from '../vm/custom32/platform.ts';
import { PortBus } from '../vm/custom32/ports.ts';
import {
  type Defines,
  GUEST_EXECUTABLE_MAGIC,
  GUEST_KERNEL_DEFINES,
  GUEST_KERNEL_LAYOUT,
} from './config.ts';

export { GUEST_EXECUTABLE_MAGIC, GUEST_KERNEL_LAYOUT } from './config.ts';

const sourceFile = (subpath: string): string =>
  readFileSync(fileURLToPath(new URL(`./${subpath}`, import.meta.url)), 'utf8');

function substituteDefines(source: string, defines: Defines, label: string): string {
  for (const key of Object.keys(defines).sort((a, b) => b.length - a.length)) {
    source = source.replace(new RegExp(`\\b${key}\\b`, 'g'), String(defines[key]));
  }
  const leftover = /\bCFG_[A-Z0-9_]+\b/.exec(source);
  if (leftover) {
    throw new Error(`guest source ${label}: unsubstituted config token ${leftover[0]}`);
  }
  return source;
}

export const GUEST_MOTD = 'welcome to jscpu-os\n';
export const GUEST_USER_PROGRAMS = [
  'init',
  'sh',
  'echo',
  'cat',
  'ls',
  'date',
  'shutdown',
  'spin',
  'wc',
  'head',
  'grep',
  'mkdir',
  'rm',
  'mv',
  'ln',
  'touch',
  'env',
  'runtests',
] as const;

function resolveUserlandInclude(name: string): string | undefined {
  try {
    return sourceFile(`userland/${name}`);
  } catch {
    return undefined;
  }
}

const LIBC_SOURCE = substituteDefines(
  preprocess(sourceFile('userland/libc.c'), resolveUserlandInclude),
  GUEST_KERNEL_DEFINES,
  'libc.c',
);

export function buildUserExecutable(name: string, programSource: string): Uint8Array {
  const base = GUEST_KERNEL_LAYOUT.userLoadBase;
  const libc = compileC(LIBC_SOURCE, { start: 'none', moduleId: `${name}_libc` });
  const expandedProgram = preprocess(programSource, resolveUserlandInclude);
  const program = compileC(substituteDefines(expandedProgram, GUEST_KERNEL_DEFINES, name), {
    start: 'user',
    moduleId: name,
    cStackSize: 4096,
  });
  const linked = linkExecutable([program, libc], { textOrigin: base });

  const [textSegment, dataSegment] = linked.executable.segments;
  if (!textSegment || !dataSegment) {
    throw new Error(`buildUserExecutable: ${name} missing segments`);
  }

  const fileImageLength = dataSegment.vaddr - base + dataSegment.data.length;
  const memorySize = dataSegment.vaddr - base + dataSegment.memSize;
  const image = new Uint8Array(fileImageLength);
  image.set(textSegment.data, textSegment.vaddr - base);
  image.set(dataSegment.data, dataSegment.vaddr - base);

  const executable = new Uint8Array(12 + fileImageLength);
  const header = new DataView(executable.buffer);
  header.setUint32(0, GUEST_EXECUTABLE_MAGIC, true);
  header.setUint32(4, linked.entry, true);
  header.setUint32(8, memorySize, true);
  executable.set(image, 12);
  return executable;
}

export interface GuestDiskImageOptions {
  kernel?: KernelImage;
}

export function buildGuestDiskImage(options: GuestDiskImageOptions = {}): Uint8Array {
  const fsDisk = BlockDisk.blank(2048);
  const ports = new PortBus();
  ports.register(PORT.DISK_DATA, 1, fsDisk);
  ports.register(PORT.DISK_POS, 1, fsDisk);
  ports.register(PORT.DISK_SECTORS, 1, fsDisk);

  const driver = new PortBlockDevice(ports);
  const fs = new Fs(driver);
  fs.mkfs();
  fs.mkdir('/dev');
  fs.mkdir('/proc');
  fs.mkdir('/tmp');
  for (const name of GUEST_USER_PROGRAMS) {
    fs.writeFile(`/bin/${name}`, buildUserExecutable(name, sourceFile(`userland/${name}.c`)));
    fs.chmod(`/bin/${name}`, 0o755);
  }
  fs.writeFile(
    '/bin/selftest',
    new TextEncoder().encode('#!/bin/sh\nruntests\necho script-pipeline | cat | cat\n'),
  );
  fs.chmod('/bin/selftest', 0o755);
  fs.writeFile('/etc/motd', new TextEncoder().encode(GUEST_MOTD));
  fs.writeFile(
    '/etc/rc',
    new TextEncoder().encode('# system initialization script\ntouch /tmp/booted\n'),
  );
  fs.writeFile('/etc/profile', new TextEncoder().encode('export PATH=/bin\n'));
  fs.writeFile(
    '/etc/packages',
    new TextEncoder().encode(`${GUEST_USER_PROGRAMS.join('\n')}\nselftest\n`),
  );

  const kernel = options.kernel ?? buildGuestKernelImage();
  const kernelBlocks = Math.ceil(kernel.flat.length / BLOCK_SIZE);
  const kernelStart = fsDisk.sectors;
  driver.write(
    0,
    encodeBootBlock(
      makeBootBlock('/bin/init', {
        kernelStart,
        kernelBlocks,
        kernelLoad: 0,
        kernelEntry: kernel.entry,
        kernelBytes: kernel.flat.length,
        kernelStack: GUEST_KERNEL_LAYOUT.kstackTop,
      }),
    ),
  );

  const image = new Uint8Array((kernelStart + kernelBlocks) * BLOCK_SIZE);
  image.set(fsDisk.data);
  image.set(kernel.flat, kernelStart * BLOCK_SIZE);
  return image;
}

// The guest kernel is split by subsystem. main.c carries the boot entry (and
// the assembly trap stubs) and is compiled with the kernel crt0; every other
// file is a plain object linked alongside it. Each file `#include`s kernel.h for
// the shared `extern` declarations and prototypes.
const KERNEL_SOURCE_FILES = [
  'main.c', // must stay first: owns _start / kmain and the shared C stack size
  'trap.c',
  'scheduler.c',
  'process.c',
  'signal.c',
  'exec.c',
  'syscall.c',
  'memory.c',
  'file.c',
  'pipe.c',
  'fs.c',
  'vfs.c',
  'drivers/console.c',
  'drivers/tty.c',
  'drivers/keyboard.c',
  'drivers/disk.c',
  'drivers/rtc.c',
  'drivers/power.c',
] as const;

function resolveKernelInclude(name: string): string | undefined {
  try {
    return sourceFile(`kernel/${name}`);
  } catch {
    return undefined;
  }
}

function compileKernelFile(subpath: string): CompiledObject {
  const expanded = preprocess(sourceFile(`kernel/${subpath}`), resolveKernelInclude);
  const source = substituteDefines(expanded, GUEST_KERNEL_DEFINES, `kernel/${subpath}`);
  return compileC(source, {
    start: subpath === 'main.c' ? 'kernel' : 'none',
    cStackSize: 8192,
    moduleId: subpath.replace(/[^A-Za-z0-9]/g, '_'),
  });
}

export function buildGuestKernelImage(): KernelImage {
  const image = linkKernelImage(KERNEL_SOURCE_FILES.map(compileKernelFile));
  if (image.flat.length > GUEST_KERNEL_LAYOUT.idt) {
    throw new Error(
      `guest kernel image overlaps reserved IDT/page-table region: image end 0x${image.flat.length.toString(16)}, IDT 0x${GUEST_KERNEL_LAYOUT.idt.toString(16)}`,
    );
  }
  return image;
}
