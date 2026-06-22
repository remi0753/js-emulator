// Hardware boundary for the custom32 VM.
//
// Machine owns only virtual hardware: CPU, physical RAM, port bus, and devices.
// It deliberately does not know about processes, syscalls, filesystems, or any
// kernel policy. The v2 TypeScript kernel is one client of this machine; a future
// guest kernel can be another.

import { CPU } from './cpu.ts';
import { Console } from './devices/console.ts';
import { BlockDisk } from './devices/disk.ts';
import { Keyboard } from './devices/keyboard.ts';
import { PhysicalMemory } from './memory.ts';
import { PortBus } from './ports.ts';
import { PORT } from './platform.ts';

export const DEFAULT_PHYS_SIZE = 16 * 1024 * 1024; // 16 MiB physical RAM
export const DEFAULT_DISK_BLOCKS = 2048; // 1 MiB fresh disk when no image is supplied

export interface MachineOptions {
  physSize?: number;
  consoleSink?: (s: string) => void;
  diskImage?: Uint8Array;
  diskBlocks?: number;
}

export class Machine {
  readonly phys: PhysicalMemory;
  readonly ports: PortBus;
  readonly cpu: CPU;
  readonly console: Console;
  readonly keyboard: Keyboard;
  readonly disk: BlockDisk;

  constructor(opts: MachineOptions = {}) {
    this.phys = new PhysicalMemory(opts.physSize ?? DEFAULT_PHYS_SIZE);
    this.ports = new PortBus();
    this.cpu = new CPU(this.phys, this.ports);

    this.console = new Console(opts.consoleSink);
    this.ports.register(PORT.CONSOLE_DATA, 1, this.console);

    this.keyboard = new Keyboard();
    this.ports.register(PORT.KBD_DATA, 1, this.keyboard);

    this.disk = opts.diskImage
      ? new BlockDisk(opts.diskImage)
      : BlockDisk.blank(opts.diskBlocks ?? DEFAULT_DISK_BLOCKS);
    this.ports.register(PORT.DISK_DATA, 1, this.disk);
    this.ports.register(PORT.DISK_POS, 1, this.disk);
    this.ports.register(PORT.DISK_SECTORS, 1, this.disk);
  }
}
