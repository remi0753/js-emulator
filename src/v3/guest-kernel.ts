import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeBootBlock, makeBootBlock } from '../formats/bootblock.ts';
import type { ObjectFile } from '../formats/object.ts';
import { BLOCK_SIZE } from '../storage/block.ts';
import { Fs } from '../storage/fs.ts';
import { PortBlockDevice } from '../storage/port-block-device.ts';
import { compileObject, crt0Object, kernelCrt0Object } from '../toolchain/cc.ts';
import type { IncludeResolver } from '../toolchain/chibicc/index.ts';
import { floatRuntimeArchive } from '../toolchain/chibicc/runtimeFloat.ts';
import { i64RuntimeObject } from '../toolchain/chibicc/runtime64.ts';
import { type KernelImage, linkKernelImage } from '../toolchain/object-linker.ts';
import { BlockDisk } from '../vm/custom32/devices/disk.ts';
import { PORT } from '../vm/custom32/platform.ts';
import { PortBus } from '../vm/custom32/ports.ts';
import { linkGuestExecutable } from './guest-cc.ts';
import {
  type Defines,
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
  'nc',
  'dmesg',
  'ps',
  'runtests',
] as const;

function resolveGuestInclude(dir: 'userland' | 'kernel'): IncludeResolver {
  return (name) => {
    try {
      return {
        path: `${dir}/${name}`,
        text: substituteDefines(sourceFile(`${dir}/${name}`), GUEST_KERNEL_DEFINES, `${dir}/${name}`),
      };
    } catch {
      return undefined;
    }
  };
}

const resolveUserlandInclude = resolveGuestInclude('userland');
const resolveKernelInclude = resolveGuestInclude('kernel');

function kernelSource(subpath: string): string {
  return substituteDefines(sourceFile(`kernel/${subpath}`), GUEST_KERNEL_DEFINES, `kernel/${subpath}`);
}

function compileUserlandObject(source: string, name: string): ObjectFile {
  return compileObject(source, { name: `${name}.o`, resolveInclude: resolveUserlandInclude });
}

function needsChibiccRuntime(objects: ObjectFile[]): boolean {
  return objects.some((obj) =>
    obj.symbols.some(
      (sym) =>
        sym.section === 'undef' &&
        (sym.name.startsWith('__i64_') ||
          sym.name.startsWith('__u64_') ||
          /^__(add|sub|mul|div)[sd]f3$/.test(sym.name) ||
          /^__cmp[sd]f2$/.test(sym.name) ||
          /^__(float|fix|extend|trunc)/.test(sym.name)),
    ),
  );
}

const LIBC_SOURCE = substituteDefines(
  sourceFile('userland/libc.c'),
  GUEST_KERNEL_DEFINES,
  'libc.c',
);

export function buildUserExecutable(name: string, programSource: string): Uint8Array {
  const libc = compileUserlandObject(LIBC_SOURCE, `${name}_libc`);
  const program = compileUserlandObject(
    substituteDefines(programSource, GUEST_KERNEL_DEFINES, name),
    name,
  );
  const objects = [crt0Object(), program, libc];
  if (needsChibiccRuntime(objects)) objects.push(i64RuntimeObject());
  return linkGuestExecutable(objects, [floatRuntimeArchive()]);
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
  fs.mkdir('/sys');
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
  'klog.c',
  'trap.c',
  'scheduler.c',
  'process.c',
  'signal.c',
  'exec.c',
  'syscall.c',
  'memory.c',
  'file.c',
  'pipe.c',
  'network.c',
  'fs.c',
  'vfs.c',
  'device.c',
  'drivers/console.c',
  'drivers/tty.c',
  'drivers/keyboard.c',
  'drivers/network.c',
  'drivers/disk.c',
  'drivers/rtc.c',
  'drivers/power.c',
] as const;

function compileKernelFile(subpath: string): ObjectFile {
  return compileObject(kernelSource(subpath), {
    name: `${subpath.replace(/[^A-Za-z0-9]/g, '_')}.o`,
    resolveInclude: resolveKernelInclude,
  });
}

export function buildGuestKernelImage(): KernelImage {
  const image = linkKernelImage([kernelCrt0Object(8192), ...KERNEL_SOURCE_FILES.map(compileKernelFile)]);
  if (image.flat.length > GUEST_KERNEL_LAYOUT.idt) {
    throw new Error(
      `guest kernel image overlaps reserved IDT/page-table region: image end 0x${image.flat.length.toString(16)}, IDT 0x${GUEST_KERNEL_LAYOUT.idt.toString(16)}`,
    );
  }
  return image;
}
