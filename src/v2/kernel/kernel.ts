// The v2 kernel (TypeScript), running on the virtual hardware.
//
// It owns the physical/virtual memory managers, a timer-driven preemptive
// scheduler, syscall dispatch, and device drivers. User programs run as guest
// bytecode in USER mode; they enter the kernel only via trap / fault / IRQ.

import { CPU, type CpuState, MODE, type RunResult } from '../hw/cpu.ts';
import { Console } from '../hw/devices/console.ts';
import { BlockDisk } from '../hw/devices/disk.ts';
import { PAGE_SIZE, PhysicalMemory } from '../hw/memory.ts';
import { PortBus } from '../hw/ports.ts';
import { FD, LAYOUT, O, PORT, SYS, SYSCALL_INT } from './abi.ts';
import { BlockDriver } from './disk.ts';
import { type Executable, encodeExecutable, flatExecutable, parseExecutable, SEG } from './exec.ts';
import { Fs, T_DIR } from './fs.ts';
import { Pmm } from './pmm.ts';
import type { OpenFile, Process } from './process.ts';
import { BadAddress, PTE, Vmm } from './vmm.ts';

const PHYS_SIZE = 16 * 1024 * 1024; // 16 MiB physical RAM
const PMM_BASE = 1 * 1024 * 1024; // manage frames from 1 MiB up (low memory reserved)
const ERR = 0xffffffff; // syscall error return (-1 unsigned)
const DEFAULT_DISK_BLOCKS = 2048; // 1 MiB fresh disk when no image is supplied
const NFD = 16; // open files per process

export interface KernelOptions {
  quantum?: number; // instructions per time slice
  consoleSink?: (s: string) => void; // where console output goes (tests capture it)
  log?: (msg: string) => void; // kernel log
  diskImage?: Uint8Array; // mount an existing disk image (else format a fresh one)
  diskBlocks?: number; // size of a freshly formatted disk
}

export class Kernel {
  readonly phys: PhysicalMemory;
  readonly ports: PortBus;
  readonly cpu: CPU;
  readonly pmm: Pmm;
  readonly vmm: Vmm;
  readonly console: Console;
  readonly disk: BlockDisk;
  readonly bio: BlockDriver;
  readonly fs: Fs;

  readonly processes = new Map<number, Process>();
  private readyQueue: Process[] = [];
  private nextPid = 1;

  readonly quantum: number;
  private log: (msg: string) => void;

  constructor(opts: KernelOptions = {}) {
    this.quantum = opts.quantum ?? 1000;
    this.log = opts.log ?? (() => {});

    this.phys = new PhysicalMemory(PHYS_SIZE);
    this.ports = new PortBus();
    this.cpu = new CPU(this.phys, this.ports);
    this.pmm = new Pmm(this.phys, PMM_BASE);
    this.vmm = new Vmm(this.phys, this.cpu.mmu, this.pmm);

    this.console = new Console(opts.consoleSink);
    this.ports.register(PORT.CONSOLE_DATA, 1, this.console);

    // Block disk + filesystem. Mount a supplied image, or format a fresh disk.
    this.disk = opts.diskImage
      ? new BlockDisk(opts.diskImage)
      : BlockDisk.blank(opts.diskBlocks ?? DEFAULT_DISK_BLOCKS);
    this.ports.register(PORT.DISK_DATA, 1, this.disk);
    this.ports.register(PORT.DISK_POS, 1, this.disk);
    this.ports.register(PORT.DISK_SECTORS, 1, this.disk);
    this.bio = new BlockDriver(this.ports);
    this.fs = new Fs(this.bio);
    if (opts.diskImage) this.fs.mount();
    else this.fs.mkfs();
  }

  // --- program installation (write an executable into the filesystem) ---

  // Write an executable to the filesystem at `path` (creating parent dirs) so it
  // can later be exec()'d. A flat assembled image is wrapped as one segment.
  install(path: string, prog: Executable | Uint8Array): void {
    const exe = prog instanceof Uint8Array ? flatExecutable(prog) : prog;
    this.fs.writeFile(path, encodeExecutable(exe));
  }

  // --- process creation (loader) ---

  // Build an address space for a program image and start it in USER mode.
  // Accepts a flat assembled image (wrapped as a single segment) or a full
  // Executable.
  spawn(name: string, prog: Uint8Array | Executable): Process {
    const exe = prog instanceof Uint8Array ? flatExecutable(prog) : prog;
    const { pd, entry } = this.loadExecutable(exe);

    const proc: Process = {
      pid: this.nextPid++,
      name,
      state: 'ready',
      exitCode: null,
      pd,
      cpu: this.userState(pd, entry),
      parent: null,
      children: [],
      waitStatusPtr: 0,
      fds: this.stdioFds(),
    };
    this.processes.set(proc.pid, proc);
    this.readyQueue.push(proc);
    return proc;
  }

  // Load an executable from a file on the filesystem and start it (a tiny "boot
  // loader" — how init is brought up before there is a shell to exec it).
  spawnFromFile(name: string, path: string): Process {
    const inum = this.fs.namei(path);
    if (inum === 0) throw new Error(`spawnFromFile: no such file: ${path}`);
    return this.spawn(name, parseExecutable(this.fs.readFile(inum)));
  }

  // The standard fd table for a new process: stdin/stdout/stderr on the console.
  private stdioFds(): (OpenFile | null)[] {
    const fds: (OpenFile | null)[] = new Array(NFD).fill(null);
    fds[FD.STDIN] = {
      kind: 'console',
      inum: 0,
      offset: 0,
      readable: true,
      writable: false,
      ref: 1,
    };
    fds[FD.STDOUT] = {
      kind: 'console',
      inum: 0,
      offset: 0,
      readable: false,
      writable: true,
      ref: 1,
    };
    fds[FD.STDERR] = {
      kind: 'console',
      inum: 0,
      offset: 0,
      readable: false,
      writable: true,
      ref: 1,
    };
    return fds;
  }

  // Load an executable into a fresh address space: map each segment (zero-filling
  // BSS) and the user stack. Returns the new page directory and entry point.
  private loadExecutable(exe: Executable): { pd: number; entry: number } {
    const pd = this.vmm.createAddressSpace();
    for (const seg of exe.segments) {
      const flags = PTE.U | (seg.flags & SEG.W ? PTE.W : 0);
      this.vmm.loadSegment(pd, seg.vaddr, seg.data, seg.memSize, flags);
    }
    // Map the user stack pages just below the stack top.
    for (let i = 1; i <= LAYOUT.USER_STACK_PAGES; i++) {
      this.vmm.mapPage(pd, LAYOUT.USER_STACK_TOP - i * PAGE_SIZE, PTE.U | PTE.W);
    }
    return { pd, entry: exe.entry };
  }

  // A fresh USER-mode CPU state for a newly loaded image.
  private userState(pd: number, entry: number): CpuState {
    return {
      regs: new Array(8).fill(0),
      pc: entry,
      sp: LAYOUT.USER_STACK_TOP,
      flags: 0,
      mode: MODE.USER,
      ptbr: pd,
      pagingEnabled: true,
    };
  }

  // --- scheduler (timer-driven, preemptive round-robin) ---

  run(): void {
    while (this.readyQueue.length > 0) {
      const proc = this.readyQueue.shift()!;
      proc.state = 'running';

      this.cpu.loadState(proc.cpu);
      const r = this.cpu.run(this.quantum);
      this.cpu.saveState(proc.cpu);

      this.dispatch(proc, r);
    }
  }

  private dispatch(proc: Process, r: RunResult): void {
    switch (r.reason) {
      case 'timer': // quantum expired -> preempt, back to the tail
        this.ready(proc);
        break;
      case 'syscall':
        if (r.num === SYSCALL_INT) this.handleSyscall(proc);
        else {
          this.log(`pid ${proc.pid}: unexpected INT 0x${r.num.toString(16)} -> killed`);
          this.exit(proc, -1);
        }
        break;
      case 'irq': // no IRQ-raising devices in Phase 2; just resume
        this.ready(proc);
        break;
      case 'pagefault':
        this.log(
          `pid ${proc.pid} (${proc.name}): page fault @0x${r.vaddr.toString(16)} ` +
            `(${r.present ? 'protection' : 'not-present'}) -> killed`,
        );
        this.exit(proc, -1);
        break;
      case 'fault':
        this.log(`pid ${proc.pid} (${proc.name}): fault: ${r.message} -> killed`);
        this.exit(proc, -1);
        break;
      case 'halt': // user mode can't HLT (privileged); treat as exit if it happens
        this.exit(proc, 0);
        break;
    }
  }

  // --- syscall dispatch ---

  private handleSyscall(proc: Process): void {
    const regs = proc.cpu.regs;
    const num = regs[0]!; // R0 = syscall number

    switch (num) {
      case SYS.EXIT:
        this.log(`pid ${proc.pid} (${proc.name}): exit ${regs[1]! | 0}`);
        this.exit(proc, regs[1]! | 0);
        break;

      case SYS.WRITE: {
        regs[0] = this.sysWrite(proc, regs[1]!, regs[2]!, regs[3]!);
        this.ready(proc);
        break;
      }

      case SYS.YIELD:
        this.ready(proc);
        break;

      case SYS.GETPID:
        regs[0] = proc.pid;
        this.ready(proc);
        break;

      case SYS.FORK: {
        const child = this.fork(proc);
        regs[0] = child.pid; // parent sees the child's pid
        child.cpu.regs[0] = 0; // child sees 0
        this.ready(child);
        this.ready(proc);
        break;
      }

      case SYS.EXEC:
        // On success the image is replaced (regs reset, R0 irrelevant); on
        // failure -1 is returned to the still-running caller.
        regs[0] = this.sysExec(proc, regs[1]!);
        this.ready(proc);
        break;

      case SYS.WAIT:
        // sysWait either reaps a zombie now or blocks the process until one exits.
        this.sysWait(proc, regs[1]!);
        break;

      case SYS.OPEN:
        regs[0] = this.sysOpen(proc, regs[1]!, regs[2]!);
        this.ready(proc);
        break;

      case SYS.CLOSE:
        regs[0] = this.sysClose(proc, regs[1]!);
        this.ready(proc);
        break;

      case SYS.READ:
        regs[0] = this.sysRead(proc, regs[1]!, regs[2]!, regs[3]!);
        this.ready(proc);
        break;

      default:
        this.log(`pid ${proc.pid}: unknown syscall ${num}`);
        regs[0] = ERR;
        this.ready(proc);
        break;
    }
  }

  // --- file syscalls ---

  // write(fd, buf, len): console output or a write into a file at its offset.
  private sysWrite(proc: Process, fd: number, buf: number, len: number): number {
    const of = proc.fds[fd];
    if (!of?.writable) return ERR;
    try {
      const data = this.vmm.copyin(proc.pd, buf, len);
      if (of.kind === 'console') {
        for (const b of data) this.ports.out(PORT.CONSOLE_DATA, b);
        return len;
      }
      const din = this.fs.readInode(of.inum);
      const n = this.fs.writei(of.inum, din, of.offset, data);
      of.offset += n;
      return n;
    } catch (e) {
      if (e instanceof BadAddress) return ERR;
      throw e;
    }
  }

  // read(fd, buf, len): read from a file at its offset into user space. The
  // console has no input yet (Phase 6), so reading stdin returns 0 (EOF).
  private sysRead(proc: Process, fd: number, buf: number, len: number): number {
    const of = proc.fds[fd];
    if (!of?.readable) return ERR;
    if (of.kind === 'console') return 0;
    try {
      const din = this.fs.readInode(of.inum);
      const data = this.fs.readi(din, of.offset, len);
      this.vmm.copyout(proc.pd, buf, data);
      of.offset += data.length;
      return data.length;
    } catch (e) {
      if (e instanceof BadAddress) return ERR;
      throw e;
    }
  }

  // open(path, flags): resolve (optionally create) a file and install an fd.
  private sysOpen(proc: Process, pathPtr: number, flags: number): number {
    let path: string;
    try {
      path = this.vmm.copyinStr(proc.pd, pathPtr);
    } catch (e) {
      if (e instanceof BadAddress) return ERR;
      throw e;
    }

    let inum = this.fs.namei(path);
    if (inum === 0) {
      if ((flags & O.CREATE) === 0) return ERR;
      try {
        inum = this.fs.create(path, /* T_FILE */ 2);
      } catch {
        return ERR;
      }
    }

    const din = this.fs.readInode(inum);
    const writable = din.type !== T_DIR && (flags & (O.WRONLY | O.RDWR)) !== 0;
    if ((flags & O.TRUNC) !== 0 && writable) this.fs.itrunc(inum, din);
    const readable = (flags & O.WRONLY) === 0;

    const fd = proc.fds.indexOf(null);
    if (fd === -1) return ERR;
    proc.fds[fd] = { kind: 'file', inum, offset: 0, readable, writable, ref: 1 };
    return fd;
  }

  // close(fd): drop the descriptor (and its reference to the open file).
  private sysClose(proc: Process, fd: number): number {
    const of = proc.fds[fd];
    if (!of) return ERR;
    of.ref--;
    proc.fds[fd] = null;
    return 0;
  }

  // --- process model: fork / exec / wait / exit ---

  // Duplicate `parent` into a new process with a copied address space. Both
  // resume just after the trapping INT; the caller wires up the return values.
  private fork(parent: Process): Process {
    const pd = this.vmm.cloneAddressSpace(parent.pd);
    const src = parent.cpu;
    const cpu: CpuState = {
      regs: src.regs.slice(), // independent register file
      pc: src.pc,
      sp: src.sp,
      flags: src.flags,
      mode: src.mode,
      ptbr: pd, // its own address space
      pagingEnabled: src.pagingEnabled,
    };
    // Share open files with the parent (dup each fd, bumping its ref count).
    const fds = parent.fds.map((of) => {
      if (of) of.ref++;
      return of;
    });
    const child: Process = {
      pid: this.nextPid++,
      name: parent.name,
      state: 'ready',
      exitCode: null,
      pd,
      cpu,
      parent: parent.pid,
      children: [],
      waitStatusPtr: 0,
      fds,
    };
    parent.children.push(child.pid);
    this.processes.set(child.pid, child);
    return child;
  }

  // Replace the caller's image with the executable file at `pathPtr`, read from
  // the filesystem. Open file descriptors are preserved across exec (Unix
  // semantics). Returns ERR (caller intact) if the path is bad or not a program.
  private sysExec(proc: Process, pathPtr: number): number {
    let path: string;
    try {
      path = this.vmm.copyinStr(proc.pd, pathPtr);
    } catch (e) {
      if (e instanceof BadAddress) return ERR;
      throw e;
    }
    const inum = this.fs.namei(path);
    if (inum === 0) {
      this.log(`pid ${proc.pid}: exec '${path}' -> not found`);
      return ERR;
    }
    let exe: Executable;
    try {
      exe = parseExecutable(this.fs.readFile(inum));
    } catch {
      this.log(`pid ${proc.pid}: exec '${path}' -> not an executable`);
      return ERR;
    }
    // Build the new address space first, then drop the old one (so a failure
    // before this point leaves the caller runnable). fds are intentionally kept.
    const { pd, entry } = this.loadExecutable(exe);
    this.vmm.freeAddressSpace(proc.pd);
    proc.pd = pd;
    proc.name = path;
    Object.assign(proc.cpu, this.userState(pd, entry));
    return 0; // overwritten by the new image anyway
  }

  // Reap a zombie child if one exists, else block until one does (or return -1
  // when there are no children at all).
  private sysWait(proc: Process, statusPtr: number): void {
    if (proc.children.length === 0) {
      proc.cpu.regs[0] = ERR;
      this.ready(proc);
      return;
    }
    proc.waitStatusPtr = statusPtr;
    if (!this.tryReap(proc)) proc.state = 'waiting'; // block; not enqueued
  }

  // If `parent` has a zombie child, reap it: free the PCB, hand the pid back in
  // R0, write the exit code to the saved status pointer, and make the parent
  // ready. Returns whether a child was reaped.
  private tryReap(parent: Process): boolean {
    const childPid = parent.children.find((pid) => this.processes.get(pid)?.state === 'zombie');
    if (childPid === undefined) return false;

    const child = this.processes.get(childPid)!;
    parent.children = parent.children.filter((pid) => pid !== childPid);
    this.processes.delete(childPid);

    if (parent.waitStatusPtr !== 0) {
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setInt32(0, child.exitCode ?? 0, true);
      try {
        this.vmm.copyout(parent.pd, parent.waitStatusPtr, buf);
      } catch (e) {
        if (!(e instanceof BadAddress)) throw e; // bad status ptr: drop it, still reap
      }
    }
    parent.waitStatusPtr = 0;
    parent.cpu.regs[0] = child.pid;
    this.ready(parent);
    return true;
  }

  // Terminate a process: free its address space, reparent its children to init
  // (pid 1), become a zombie, and wake a parent waiting on it. Also used for
  // fault-driven kills.
  private exit(proc: Process, code: number): void {
    if (proc.pd !== 0) {
      this.vmm.freeAddressSpace(proc.pd);
      proc.pd = 0;
    }
    // Release every open file descriptor.
    for (let fd = 0; fd < proc.fds.length; fd++) {
      const of = proc.fds[fd];
      if (of) of.ref--;
      proc.fds[fd] = null;
    }
    proc.state = 'zombie';
    proc.exitCode = code | 0;

    // Reparent surviving children to init so their zombies can still be reaped.
    const init = this.processes.get(1);
    const reparent = init && init !== proc ? init : undefined;
    for (const cpid of proc.children) {
      const c = this.processes.get(cpid);
      if (c) c.parent = reparent ? reparent.pid : null;
    }
    if (reparent) {
      reparent.children.push(...proc.children);
      if (reparent.state === 'waiting') this.tryReap(reparent);
    }
    proc.children = [];

    // Wake the parent if it is blocked in wait().
    const parent = proc.parent !== null ? this.processes.get(proc.parent) : undefined;
    if (parent && parent.state === 'waiting') this.tryReap(parent);
  }

  // --- process state transitions ---

  private ready(proc: Process): void {
    proc.state = 'ready';
    this.readyQueue.push(proc);
  }
}
