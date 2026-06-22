// Deterministic VM tracing (Phase 7).
//
// A Tracer attaches to a Machine's hardware components and records, in order,
// every instruction executed, every trap/return to the host, every port I/O, and
// every disk transfer. It also dumps page tables on demand. Tracing is purely
// observational: it wires the optional hooks the CPU, port bus, and disk expose,
// so a run with no tracer behaves identically (and pays nothing).
//
// "Deterministic" means the trace depends only on the guest's execution, not on
// host timing — the same program over the same input produces the same trace, so
// tests can assert on it.

import type { CPU, RunResult } from './cpu.ts';
import type { BlockDisk } from './devices/disk.ts';
import { dumpPageTable, type PageMapping } from './mmu.ts';
import type { PortBus } from './ports.ts';

// Each event carries a monotonically increasing `seq` so the four streams can be
// merged back into a single global order if needed.
export interface InstrEvent {
  seq: number;
  pc: number;
  mnemonic: string;
}
export interface TrapEvent {
  seq: number;
  result: RunResult;
}
export interface PortEvent {
  seq: number;
  dir: 'in' | 'out';
  port: number;
  value: number;
}
export interface DiskEvent {
  seq: number;
  op: 'seek' | 'read' | 'write';
  at: number;
  value: number;
}

// Which streams to record. All on by default.
export interface TraceOptions {
  instr?: boolean;
  trap?: boolean;
  port?: boolean;
  disk?: boolean;
}

// The minimal hardware surface a Tracer hooks into (Machine satisfies it).
export interface Traceable {
  cpu: CPU;
  ports: PortBus;
  disk: BlockDisk;
}

export class Tracer {
  readonly instr: InstrEvent[] = [];
  readonly traps: TrapEvent[] = [];
  readonly ports: PortEvent[] = [];
  readonly disk: DiskEvent[] = [];

  private seq = 0;
  private opts: Required<TraceOptions>;
  private attached: Traceable | null = null;

  constructor(opts: TraceOptions = {}) {
    this.opts = {
      instr: opts.instr ?? true,
      trap: opts.trap ?? true,
      port: opts.port ?? true,
      disk: opts.disk ?? true,
    };
  }

  // Wire the hooks on a machine's hardware. Only one Tracer per machine.
  attach(hw: Traceable): void {
    this.attached = hw;
    if (this.opts.instr) {
      hw.cpu.onTrace = (pc, mnemonic) => {
        this.instr.push({ seq: this.seq++, pc, mnemonic });
      };
    }
    if (this.opts.trap) {
      hw.cpu.onTrap = (result) => {
        this.traps.push({ seq: this.seq++, result });
      };
    }
    if (this.opts.port) {
      hw.ports.onIo = (dir, port, value) => {
        this.ports.push({ seq: this.seq++, dir, port, value });
      };
    }
    if (this.opts.disk) {
      hw.disk.onIo = (op, at, value) => {
        this.disk.push({ seq: this.seq++, op, at, value });
      };
    }
  }

  // Unwire the hooks, restoring zero-overhead execution.
  detach(): void {
    const hw = this.attached;
    if (!hw) return;
    hw.cpu.onTrace = null;
    hw.cpu.onTrap = null;
    hw.ports.onIo = null;
    hw.disk.onIo = null;
    this.attached = null;
  }

  // Drop all recorded events (keeps the attachment).
  clear(): void {
    this.instr.length = 0;
    this.traps.length = 0;
    this.ports.length = 0;
    this.disk.length = 0;
    this.seq = 0;
  }

  // Dump the page table currently loaded in the CPU (CR3 / ptbr).
  pageTable(ptbr?: number): PageMapping[] {
    const hw = this.attached;
    if (!hw) throw new Error('Tracer.pageTable: not attached to a machine');
    return dumpPageTable(hw.cpu.phys, ptbr ?? hw.cpu.ptbr);
  }

  // A human-readable dump of every recorded stream, in global sequence order.
  toText(): string {
    const lines: string[] = [];
    const merged: { seq: number; text: string }[] = [
      ...this.instr.map((e) => ({ seq: e.seq, text: `insn @0x${hex(e.pc)} ${e.mnemonic}` })),
      ...this.traps.map((e) => ({ seq: e.seq, text: `trap ${formatTrap(e.result)}` })),
      ...this.ports.map((e) => ({
        seq: e.seq,
        text: `port ${e.dir.toUpperCase()} 0x${hex(e.port)} = 0x${hex(e.value)}`,
      })),
      ...this.disk.map((e) => ({
        seq: e.seq,
        text: `disk ${e.op} @0x${hex(e.at)} = 0x${hex(e.value)}`,
      })),
    ];
    merged.sort((a, b) => a.seq - b.seq);
    for (const m of merged) lines.push(m.text);
    return lines.join('\n');
  }
}

function hex(n: number): string {
  return (n >>> 0).toString(16);
}

// Compact one-line description of why run() returned.
export function formatTrap(r: RunResult): string {
  switch (r.reason) {
    case 'syscall':
      return `syscall INT 0x${hex(r.num)}`;
    case 'pagefault':
      return `pagefault @0x${hex(r.vaddr)} ${r.write ? 'write' : 'read'} ${
        r.present ? 'protection' : 'not-present'
      }${r.user ? ' user' : ''}`;
    case 'fault':
      return `fault ${r.kind}: ${r.message}`;
    case 'irq':
      return `irq ${r.line}`;
    default:
      return r.reason; // timer, halt
  }
}
