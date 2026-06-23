import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ARG_SIZE,
  FLAG,
  IDT_ENTRY_SIZE,
  IDT_PRESENT,
  IDT_USER,
  KEYBOARD_IRQ,
  SYSCALL_INT,
  TIMER_IRQ,
  TRAP,
} from '../isa.ts';
import { compileC } from '../toolchain/c.ts';
import { type KernelImage, linkExecutable, linkKernelImage } from '../toolchain/linker.ts';
import { SYS } from '../v2/kernel/abi.ts';
import { BOOT_MAGIC, encodeBootBlock, makeBootBlock } from '../v2/kernel/bootblock.ts';
import { BlockDriver } from '../v2/kernel/disk.ts';
import { DIRSIZ, FSMAGIC, Fs, NDIRECT, ROOTINO, T_DIR, T_FILE } from '../v2/kernel/fs.ts';
import { MODE } from '../vm/custom32/cpu.ts';
import { BlockDisk, SECTOR_SIZE } from '../vm/custom32/devices/disk.ts';
import { POWER_OFF } from '../vm/custom32/devices/power.ts';
import { PORT } from '../vm/custom32/platform.ts';
import { PortBus } from '../vm/custom32/ports.ts';

type Defines = Record<string, number | string>;

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

const MAX_PROC = 8;
const NBUF = 16;
const NFD = 16;
const NPIPE = 8;
const PIPESZ = 512;
const MAXARG = 16;
const ARGBUF_LEN = 512;
const DINODE_SIZE = 64;
const IPB = SECTOR_SIZE / DINODE_SIZE;
const PTE_KERNEL = 3;
const PTE_USER = 7;
export const GUEST_EXECUTABLE_MAGIC = 0x35315850;
const PIPEWAIT = 4;

const PROCESS_STATE = {
  unused: 0,
  runnable: 1,
  zombie: 2,
  blocked: 3,
} as const;

const FILE_TYPE = {
  none: 0,
  console: 1,
  keyboard: 2,
  file: 3,
  pipe: 4,
} as const;

export const GUEST_KERNEL_LAYOUT = {
  idt: 0x40000,
  kernelPageTable: 0x41000,
  kstackTop: 0x50000,
  framePoolBase: 0x100000,
  framePoolEnd: 0x380000,
  timerPeriod: 8000,
  physSize: 0x400000,
  userLoadBase: 0x400000,
  userStackPage: 0x7ff000,
  userStackTop: 0x800000,
  userBase: 0x400000,
  userEnd: 0x800000,
} as const;

export const GUEST_MOTD = 'welcome to jscpu-os\n';

function syscallDefines(): Defines {
  return {
    CFG_SYS_EXIT: SYS.EXIT,
    CFG_SYS_WRITE: SYS.WRITE,
    CFG_SYS_READ: SYS.READ,
    CFG_SYS_YIELD: SYS.YIELD,
    CFG_SYS_GETPID: SYS.GETPID,
    CFG_SYS_FORK: SYS.FORK,
    CFG_SYS_EXEC: SYS.EXEC,
    CFG_SYS_WAIT: SYS.WAIT,
    CFG_SYS_OPEN: SYS.OPEN,
    CFG_SYS_CLOSE: SYS.CLOSE,
    CFG_SYS_PIPE: SYS.PIPE,
    CFG_SYS_DUP: SYS.DUP,
    CFG_SYS_TIME: SYS.TIME,
    CFG_SYS_SHUTDOWN: SYS.SHUTDOWN,
  };
}

const LIBC_SOURCE = substituteDefines(sourceFile('userland/libc.c'), syscallDefines(), 'libc.c');

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

  const driver = new BlockDriver(ports);
  const fs = new Fs(driver);
  fs.mkfs();
  for (const name of ['init', 'sh', 'echo', 'cat', 'ls', 'date', 'shutdown']) {
    fs.writeFile(`/bin/${name}`, buildUserExecutable(name, sourceFile(`userland/${name}.c`)));
  }
  fs.writeFile('/etc/motd', new TextEncoder().encode(GUEST_MOTD));
  driver.write(0, encodeBootBlock(makeBootBlock('/bin/init')));
  return disk.data;
}

function kernelDefines(): Defines {
  const layout = GUEST_KERNEL_LAYOUT;
  return {
    ...syscallDefines(),
    CFG_CONSOLE_DATA: PORT.CONSOLE_DATA,
    CFG_KBD_DATA: PORT.KBD_DATA,
    CFG_KBD_STATUS: PORT.KBD_STATUS,
    CFG_KBD_VECTOR: TRAP.IRQ_BASE + KEYBOARD_IRQ,
    CFG_DISK_POS: PORT.DISK_POS,
    CFG_DISK_DATA: PORT.DISK_DATA,
    CFG_RTC_DATA: PORT.RTC_DATA,
    CFG_POWER: PORT.POWER,
    CFG_POWER_OFF: POWER_OFF,
    CFG_PTE_KERNEL: PTE_KERNEL,
    CFG_PTE_USER: PTE_USER,
    CFG_MAX_PROC: MAX_PROC,
    CFG_PROC_REG_COUNT: MAX_PROC * 8,
    CFG_NFD: NFD,
    CFG_FD_TABLE_LEN: MAX_PROC * NFD,
    CFG_NPIPE: NPIPE,
    CFG_PIPESZ: PIPESZ,
    CFG_PIPE_BUF_LEN: NPIPE * PIPESZ,
    CFG_MAXARG: MAXARG,
    CFG_ARGBUF_LEN: ARGBUF_LEN,
    CFG_FRAME_POOL_BASE: layout.framePoolBase,
    CFG_FRAME_POOL_END: layout.framePoolEnd,
    CFG_KERNEL_PT: layout.kernelPageTable,
    CFG_USER_LOAD_BASE: layout.userLoadBase,
    CFG_USER_STACK_PAGE: layout.userStackPage,
    CFG_USER_STACK_TOP: layout.userStackTop,
    CFG_USER_BASE: layout.userBase,
    CFG_USER_END: layout.userEnd,
    CFG_IDT: layout.idt,
    CFG_IDT_ENTRY_SIZE: IDT_ENTRY_SIZE,
    CFG_IDT_PRESENT: IDT_PRESENT,
    CFG_IDT_USER: IDT_USER,
    CFG_TIMER_VECTOR: TRAP.IRQ_BASE + TIMER_IRQ,
    CFG_PAGEFAULT_VECTOR: TRAP.PAGEFAULT,
    CFG_SYSCALL_VECTOR: SYSCALL_INT,
    CFG_SYSCALL_INSTR_SIZE: 1 + ARG_SIZE.imm,
    CFG_KSTACK_TOP: layout.kstackTop,
    CFG_TIMER_PERIOD: layout.timerPeriod,
    CFG_FLAG_IF: FLAG.IF,
    CFG_MODE_USER: MODE.USER,
    CFG_ST_UNUSED: PROCESS_STATE.unused,
    CFG_ST_RUNNABLE: PROCESS_STATE.runnable,
    CFG_ST_ZOMBIE: PROCESS_STATE.zombie,
    CFG_ST_BLOCKED: PROCESS_STATE.blocked,
    CFG_ST_PIPEWAIT: PIPEWAIT,
    CFG_FT_NONE: FILE_TYPE.none,
    CFG_FT_CONS: FILE_TYPE.console,
    CFG_FT_KBD: FILE_TYPE.keyboard,
    CFG_FT_FILE: FILE_TYPE.file,
    CFG_FT_PIPE: FILE_TYPE.pipe,
    CFG_NBUF: NBUF,
    CFG_BUF_DATA_LEN: NBUF * SECTOR_SIZE,
    CFG_INITPATH_LEN: 64,
    CFG_FS_MAGIC: FSMAGIC,
    CFG_BOOT_MAGIC: BOOT_MAGIC,
    CFG_EXEC_MAGIC: GUEST_EXECUTABLE_MAGIC,
    CFG_IPB: IPB,
    CFG_DINODE_SIZE: DINODE_SIZE,
    CFG_NDIRECT: NDIRECT,
    CFG_DIRSIZ: DIRSIZ,
    CFG_ROOTINO: ROOTINO,
    CFG_T_FILE: T_FILE,
    CFG_T_DIR: T_DIR,
  };
}

export const GUEST_KERNEL_SOURCE = substituteDefines(
  sourceFile('kernel/kernel.c'),
  kernelDefines(),
  'kernel.c',
);

export function buildGuestKernelImage(): KernelImage {
  const image = linkKernelImage([
    compileC(GUEST_KERNEL_SOURCE, {
      start: 'kernel',
      cStackSize: 8192,
      moduleId: 'guest_kernel',
    }),
  ]);
  if (image.flat.length > GUEST_KERNEL_LAYOUT.idt) {
    throw new Error(
      `guest kernel image overlaps reserved IDT/page-table region: image end 0x${image.flat.length.toString(16)}, IDT 0x${GUEST_KERNEL_LAYOUT.idt.toString(16)}`,
    );
  }
  return image;
}
