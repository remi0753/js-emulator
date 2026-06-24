import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeBootBlock, makeBootBlock } from '../formats/bootblock.ts';
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
  GUEST_SYSCALL_DEFINES,
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

const LIBC_SOURCE = substituteDefines(
  sourceFile('userland/libc.c'),
  GUEST_SYSCALL_DEFINES,
  'libc.c',
);

export function buildUserExecutable(name: string, programSource: string): Uint8Array {
  const base = GUEST_KERNEL_LAYOUT.userLoadBase;
  const libc = compileC(LIBC_SOURCE, { start: 'none', moduleId: `${name}_libc` });
  const program = compileC(programSource, { start: 'user', moduleId: name, cStackSize: 4096 });
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

export function buildGuestDiskImage(): Uint8Array {
  const disk = BlockDisk.blank(1024);
  const ports = new PortBus();
  ports.register(PORT.DISK_DATA, 1, disk);
  ports.register(PORT.DISK_POS, 1, disk);
  ports.register(PORT.DISK_SECTORS, 1, disk);

  const driver = new PortBlockDevice(ports);
  const fs = new Fs(driver);
  fs.mkfs();
  for (const name of ['init', 'sh', 'echo', 'cat', 'ls', 'date', 'shutdown']) {
    fs.writeFile(`/bin/${name}`, buildUserExecutable(name, sourceFile(`userland/${name}.c`)));
  }
  fs.writeFile('/etc/motd', new TextEncoder().encode(GUEST_MOTD));
  driver.write(0, encodeBootBlock(makeBootBlock('/bin/init')));
  return disk.data;
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
  'exec.c',
  'syscall.c',
  'memory.c',
  'file.c',
  'pipe.c',
  'fs.c',
  'drivers/console.c',
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
