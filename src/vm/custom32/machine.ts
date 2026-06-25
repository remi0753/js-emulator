// Hardware boundary for the custom32 VM.
//
// Machine owns only virtual hardware: CPU, physical RAM, MMU, port bus, devices,
// pending interrupts, and reset/load/run operations. It deliberately does not
// know about processes, syscalls, filesystems, or any kernel policy. The v2
// TypeScript kernel is one client of this machine; a future guest kernel
// (model B) can boot directly through this boundary instead.

import { KEYBOARD_IRQ, NETWORK_IRQ } from '../../isa.ts';
import { CPU, type CpuState, MODE, NUM_REGS, type RunResult } from './cpu.ts';
import { Console } from './devices/console.ts';
import { BlockDisk } from './devices/disk.ts';
import { Keyboard } from './devices/keyboard.ts';
import { NetworkCard } from './devices/network.ts';
import { Power } from './devices/power.ts';
import { Rtc } from './devices/rtc.ts';
import { PhysicalMemory } from './memory.ts';
import { PORT } from './platform.ts';
import { PortBus } from './ports.ts';
import { type TraceOptions, Tracer } from './trace.ts';

export const DEFAULT_PHYS_SIZE = 16 * 1024 * 1024; // 16 MiB physical RAM
export const DEFAULT_DISK_BLOCKS = 2048; // 1 MiB fresh disk when no image is supplied

export interface MachineOptions {
  physSize?: number;
  consoleSink?: (s: string) => void;
  diskImage?: Uint8Array;
  diskBlocks?: number;
  // RTC clock source: a fixed Unix timestamp (seconds) for deterministic tests,
  // or a function returning one. Defaults to the host wall clock.
  rtcTime?: number | (() => number);
  // Attach a deterministic tracer at construction. `true` traces every stream;
  // pass an object to select streams. Available afterwards as `machine.tracer`.
  trace?: boolean | TraceOptions;
}

export class Machine {
  readonly phys: PhysicalMemory;
  readonly ports: PortBus;
  readonly cpu: CPU;
  readonly console: Console;
  readonly keyboard: Keyboard;
  readonly disk: BlockDisk;
  readonly network: NetworkCard;
  readonly rtc: Rtc;
  readonly power: Power;
  readonly tracer: Tracer | null;

  constructor(opts: MachineOptions = {}) {
    this.phys = new PhysicalMemory(opts.physSize ?? DEFAULT_PHYS_SIZE);
    this.ports = new PortBus();
    this.cpu = new CPU(this.phys, this.ports);

    this.console = new Console(opts.consoleSink);
    this.ports.register(PORT.CONSOLE_DATA, 1, this.console);

    this.keyboard = new Keyboard();
    this.ports.register(PORT.KBD_DATA, 1, this.keyboard);
    this.ports.register(PORT.KBD_STATUS, 1, this.keyboard);
    this.keyboard.onInput = () => this.cpu.raiseIrq(KEYBOARD_IRQ);

    this.disk = opts.diskImage
      ? new BlockDisk(opts.diskImage)
      : BlockDisk.blank(opts.diskBlocks ?? DEFAULT_DISK_BLOCKS);
    this.ports.register(PORT.DISK_DATA, 1, this.disk);
    this.ports.register(PORT.DISK_POS, 1, this.disk);
    this.ports.register(PORT.DISK_SECTORS, 1, this.disk);

    this.rtc = new Rtc(opts.rtcTime);
    this.ports.register(PORT.RTC_DATA, 1, this.rtc);

    this.network = new NetworkCard({
      status: PORT.NET_STATUS,
      rxLength: PORT.NET_RX_LEN,
      rxData: PORT.NET_RX_DATA,
      txLength: PORT.NET_TX_LEN,
      txData: PORT.NET_TX_DATA,
    });
    this.ports.register(PORT.NET_STATUS, 1, this.network);
    this.ports.register(PORT.NET_RX_LEN, 1, this.network);
    this.ports.register(PORT.NET_RX_DATA, 1, this.network);
    this.ports.register(PORT.NET_TX_LEN, 1, this.network);
    this.ports.register(PORT.NET_TX_DATA, 1, this.network);
    this.network.onReceive = () => this.cpu.raiseIrq(NETWORK_IRQ);

    this.power = new Power();
    this.power.onPowerOff = () => this.cpu.powerOff();
    this.ports.register(PORT.POWER, 1, this.power);

    this.tracer = opts.trace ? new Tracer(typeof opts.trace === 'object' ? opts.trace : {}) : null;
    this.tracer?.attach(this);
  }

  // --- boot-time operations (hardware-visible only) ---

  // Copy guest bytes into physical RAM at a physical address (e.g. a boot image).
  load(physAddr: number, bytes: Uint8Array): void {
    this.phys.bytes.set(bytes, physAddr);
  }

  // Reset the CPU to a known boot state: registers cleared, paging off, KERNEL
  // mode, stack at the top of RAM, pc at 0. Override any field via `init` (e.g.
  // `pc` to enter at a load address). Memory and devices are left intact, but
  // CPU-local transient state such as pending interrupts is cleared.
  reset(init: Partial<CpuState> = {}): void {
    this.cpu.resetTransientState();
    this.cpu.loadState({
      regs: new Array(NUM_REGS).fill(0),
      pc: 0,
      sp: this.phys.size,
      flags: 0,
      mode: MODE.KERNEL,
      ptbr: 0,
      pagingEnabled: false,
      ...init,
    });
  }

  // Run the CPU for up to maxCycles, returning the reason it stopped (trap, halt,
  // page fault, IRQ, syscall, or quantum/timer). This is the host execution
  // boundary; model-B guest code runs through here.
  run(maxCycles: number): RunResult {
    return this.cpu.run(maxCycles);
  }

  // Post a device interrupt; delivered at the next instruction boundary if IF set.
  raiseIrq(line: number): void {
    this.cpu.raiseIrq(line);
  }
}
