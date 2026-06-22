// The v2 kernel (TypeScript), running on the virtual hardware.
//
// It owns the physical/virtual memory managers, a timer-driven preemptive
// scheduler, syscall dispatch, and device drivers. User programs run as guest
// bytecode in USER mode; they enter the kernel only via trap / fault / IRQ.

import { type CPU, type CpuState, MODE, type RunResult } from '../../vm/custom32/cpu.ts';
import type { Console } from '../../vm/custom32/devices/console.ts';
import type { BlockDisk } from '../../vm/custom32/devices/disk.ts';
import type { Keyboard } from '../../vm/custom32/devices/keyboard.ts';
import { Machine } from '../../vm/custom32/machine.ts';
import { PAGE_SIZE, type PhysicalMemory } from '../../vm/custom32/memory.ts';
import type { PortBus } from '../../vm/custom32/ports.ts';
import { FD, LAYOUT, O, PORT, SYS, SYSCALL_INT } from './abi.ts';
import { BOOT_MAGIC, decodeBootBlock } from './bootblock.ts';
import { BlockDriver } from './disk.ts';
import { type Executable, encodeExecutable, flatExecutable, parseExecutable, SEG } from './exec.ts';
import { Fs, T_DIR } from './fs.ts';
import { Pmm } from './pmm.ts';
import type { OpenFile, PendingRead, Pipe, Process } from './process.ts';
import { BadAddress, PTE, Vmm } from './vmm.ts';

const PMM_BASE = 1 * 1024 * 1024; // manage frames from 1 MiB up (low memory reserved)
const ERR = 0xffffffff; // syscall error return (-1 unsigned)
const NFD = 16; // open files per process

export interface KernelOptions {
  machine?: Machine; // hardware boundary; omitted for the legacy v2 demos/tests
  quantum?: number; // instructions per time slice
  consoleSink?: (s: string) => void; // where console output goes (tests capture it)
  log?: (msg: string) => void; // kernel log
  diskImage?: Uint8Array; // mount an existing disk image (else format a fresh one)
  diskBlocks?: number; // size of a freshly formatted disk
}

export class Kernel {
  readonly machine: Machine;
  readonly phys: PhysicalMemory;
  readonly ports: PortBus;
  readonly cpu: CPU;
  readonly pmm: Pmm;
  readonly vmm: Vmm;
  readonly console: Console;
  readonly keyboard: Keyboard;
  readonly disk: BlockDisk;
  readonly bio: BlockDriver;
  readonly fs: Fs;

  readonly processes = new Map<number, Process>();
  private readyQueue: Process[] = [];
  private nextPid = 1;
  private ticks = 0; // scheduler slices since boot (uptime)
  private inputWaiters: PendingRead[] = []; // readers blocked on the keyboard

  readonly quantum: number;
  private log: (msg: string) => void;

  constructor(opts: KernelOptions = {}) {
    this.quantum = opts.quantum ?? 1000;
    this.log = opts.log ?? (() => {});

    this.machine =
      opts.machine ??
      new Machine({
        consoleSink: opts.consoleSink,
        diskImage: opts.diskImage,
        diskBlocks: opts.diskBlocks,
      });

    this.phys = this.machine.phys;
    this.ports = this.machine.ports;
    this.cpu = this.machine.cpu;
    this.console = this.machine.console;
    this.keyboard = this.machine.keyboard;
    this.disk = this.machine.disk;

    this.pmm = new Pmm(this.phys, PMM_BASE);
    this.vmm = new Vmm(this.phys, this.cpu.mmu, this.pmm);

    // Keyboard (stdin). New input "raises an IRQ" -> wake any blocked readers.
    this.keyboard.onInput = () => this.serviceInputReaders();

    // Block disk + filesystem. Mount a supplied image, or format a fresh disk.
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
  // Executable. `argv` is delivered to the program (argc in R0, argv ptr in R1).
  spawn(name: string, prog: Uint8Array | Executable, argv: string[] = []): Process {
    const exe = prog instanceof Uint8Array ? flatExecutable(prog) : prog;
    const { pd, entry } = this.loadExecutable(exe);
    const { sp, argvPtr, argc } = this.setupUserStack(pd, argv);

    const cpu = this.userState(pd, entry, sp);
    cpu.regs[0] = argc;
    cpu.regs[1] = argvPtr;

    const proc: Process = {
      pid: this.nextPid++,
      name,
      state: 'ready',
      exitCode: null,
      pd,
      cpu,
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
  spawnFromFile(name: string, path: string, argv: string[] = []): Process {
    const inum = this.fs.namei(path);
    if (inum === 0) throw new Error(`spawnFromFile: no such file: ${path}`);
    return this.spawn(name, parseExecutable(this.fs.readFile(inum)), argv);
  }

  // Boot from the on-disk boot block (Phase 9): read the manifest in sector 0 and
  // start the init program it names. This is the manifest-driven handoff — the
  // host just mounts an image and calls boot(); it does not install userland or
  // hard-code which program is init. Returns the init process (call run() next).
  boot(): Process {
    const bb = decodeBootBlock(this.bio.read(0));
    if (bb.magic !== BOOT_MAGIC) {
      throw new Error('boot: disk is not bootable (no boot block magic in sector 0)');
    }
    const inum = this.fs.namei(bb.initPath);
    if (inum === 0) throw new Error(`boot: init program not found: ${bb.initPath}`);
    this.log(`boot: starting init from ${bb.initPath}`);
    return this.spawn('init', parseExecutable(this.fs.readFile(inum)));
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
  private userState(pd: number, entry: number, sp: number = LAYOUT.USER_STACK_TOP): CpuState {
    return {
      regs: new Array(8).fill(0),
      pc: entry,
      sp,
      flags: 0,
      mode: MODE.USER,
      ptbr: pd,
      pagingEnabled: true,
    };
  }

  // Lay out argv at the top of the user stack and return the initial sp plus the
  // argv vector pointer. Strings are copied in, then an array of pointers to them
  // terminated by NULL; the program reads argc from R0 and the argv ptr from R1.
  private setupUserStack(
    pd: number,
    argv: string[],
  ): { sp: number; argvPtr: number; argc: number } {
    let p = LAYOUT.USER_STACK_TOP;
    const addrs: number[] = [];
    for (const s of argv) {
      const b = new Uint8Array(s.length + 1); // NUL-terminated
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      p -= b.length;
      this.vmm.copyout(pd, p, b);
      addrs.push(p);
    }
    p &= ~3; // align the pointer array to 4 bytes
    const argc = argv.length;
    p -= 4 * (argc + 1); // argc pointers + a NULL terminator
    const argvPtr = p;
    const word = new Uint8Array(4);
    for (let i = 0; i < argc; i++) {
      writeWord(word, addrs[i]!);
      this.vmm.copyout(pd, argvPtr + i * 4, word);
    }
    writeWord(word, 0);
    this.vmm.copyout(pd, argvPtr + argc * 4, word);
    return { sp: argvPtr, argvPtr, argc };
  }

  // --- scheduler (timer-driven, preemptive round-robin) ---

  // Run until no process is ready. Processes blocked on input remain parked; the
  // host wakes them by feeding the keyboard, then calls run() again (this models
  // a CPU that idles until the next interrupt).
  run(): void {
    while (this.readyQueue.length > 0) {
      const proc = this.readyQueue.shift()!;
      proc.state = 'running';

      this.cpu.loadState(proc.cpu);
      const r = this.cpu.run(this.quantum);
      this.cpu.saveState(proc.cpu);
      this.ticks++;

      this.dispatch(proc, r);
    }
  }

  // True while some process is parked waiting for keyboard input (so the host
  // knows to read more and feed it before calling run() again).
  get waitingForInput(): boolean {
    return this.inputWaiters.length > 0;
  }

  // Are any processes still alive (not zombies)? Used to drive an interactive loop.
  get hasLiveProcesses(): boolean {
    for (const p of this.processes.values()) if (p.state !== 'zombie') return true;
    return false;
  }

  // Queue keyboard input; wakes readers blocked in read(). `close` signals EOF.
  feedInput(s: string): void {
    this.keyboard.feed(s);
  }
  closeInput(): void {
    this.keyboard.close();
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
        // A write to a copy-on-write page is resolved by giving the process its
        // own copy, then resuming where it faulted.
        if (r.write && r.present && this.vmm.tryCow(proc.pd, r.vaddr)) {
          this.ready(proc);
          break;
        }
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
        regs[0] = this.sysExec(proc, regs[1]!, regs[2]!);
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
        // sysRead readies the process itself, or blocks it pending input.
        this.sysRead(proc, regs[1]!, regs[2]!, regs[3]!);
        break;

      case SYS.PIPE:
        regs[0] = this.sysPipe(proc, regs[1]!);
        this.ready(proc);
        break;

      case SYS.DUP:
        regs[0] = this.sysDup(proc, regs[1]!);
        this.ready(proc);
        break;

      case SYS.UPTIME:
        regs[0] = this.ticks;
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

  // write(fd, buf, len): console output, a write into a file, or into a pipe.
  private sysWrite(proc: Process, fd: number, buf: number, len: number): number {
    const of = proc.fds[fd];
    if (!of?.writable) return ERR;
    try {
      const data = this.vmm.copyin(proc.pd, buf, len);
      if (of.kind === 'console') {
        for (const b of data) this.ports.out(PORT.CONSOLE_DATA, b);
        return len;
      }
      if (of.kind === 'pipe') {
        const pipe = of.pipe!;
        if (pipe.readers === 0) return ERR; // broken pipe: nobody will ever read it
        for (const b of data) pipe.buffer.push(b);
        this.servicePipeReaders(pipe);
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

  // read(fd, buf, len): file/pipe/keyboard read. Files return immediately; the
  // keyboard and pipes block the process when no data is available yet (the
  // process is parked and woken when input arrives or all writers close).
  private sysRead(proc: Process, fd: number, buf: number, len: number): void {
    const of = proc.fds[fd];
    if (!of?.readable) {
      proc.cpu.regs[0] = ERR;
      this.ready(proc);
      return;
    }
    if (of.kind === 'file') {
      try {
        const din = this.fs.readInode(of.inum);
        const data = this.fs.readi(din, of.offset, len);
        of.offset += data.length;
        this.completeRead(proc, buf, data);
      } catch (e) {
        if (!(e instanceof BadAddress)) throw e;
        proc.cpu.regs[0] = ERR;
        this.ready(proc);
      }
      return;
    }
    if (of.kind === 'pipe') {
      const pipe = of.pipe!;
      if (pipe.buffer.length > 0 || pipe.writers === 0) {
        this.completeRead(proc, buf, take(pipe.buffer, len));
      } else {
        pipe.readWaiters.push({ proc, buf, len }); // block until a writer feeds it
        proc.state = 'blocked';
      }
      return;
    }
    // console / keyboard (stdin)
    if (this.keyboard.available > 0 || this.keyboard.closed) {
      this.completeRead(proc, buf, this.keyboard.take(len));
    } else {
      this.inputWaiters.push({ proc, buf, len }); // block until a key is pressed
      proc.state = 'blocked';
    }
  }

  // Finish a read: copy the bytes to the user buffer, set R0, and make ready.
  private completeRead(proc: Process, buf: number, data: Uint8Array): void {
    try {
      this.vmm.copyout(proc.pd, buf, data);
      proc.cpu.regs[0] = data.length;
    } catch (e) {
      if (!(e instanceof BadAddress)) throw e;
      proc.cpu.regs[0] = ERR;
    }
    this.ready(proc);
  }

  // Deliver keyboard input to blocked readers (the keyboard "IRQ handler").
  private serviceInputReaders(): void {
    while (this.inputWaiters.length > 0 && (this.keyboard.available > 0 || this.keyboard.closed)) {
      const w = this.inputWaiters.shift()!;
      this.completeRead(w.proc, w.buf, this.keyboard.take(w.len));
    }
  }

  // Deliver pipe data (or EOF, once all writers have closed) to blocked readers.
  private servicePipeReaders(pipe: Pipe): void {
    while (pipe.readWaiters.length > 0 && (pipe.buffer.length > 0 || pipe.writers === 0)) {
      const w = pipe.readWaiters.shift()!;
      this.completeRead(w.proc, w.buf, take(pipe.buffer, w.len));
    }
  }

  // pipe(int fds[2]): create a pipe and hand back its read and write fds.
  private sysPipe(proc: Process, ptr: number): number {
    const rfd = proc.fds.indexOf(null);
    if (rfd === -1) return ERR;
    proc.fds[rfd] = { kind: 'pipe', inum: 0, offset: 0, readable: true, writable: false, ref: 1 };
    const wfd = proc.fds.indexOf(null);
    if (wfd === -1) {
      proc.fds[rfd] = null;
      return ERR;
    }
    const pipe: Pipe = { buffer: [], readers: 1, writers: 1, readWaiters: [] };
    proc.fds[rfd]!.pipe = pipe;
    proc.fds[wfd] = {
      kind: 'pipe',
      inum: 0,
      offset: 0,
      readable: false,
      writable: true,
      ref: 1,
      pipe,
    };

    const out = new Uint8Array(8);
    writeWord(out.subarray(0, 4), rfd);
    writeWord(out.subarray(4, 8), wfd);
    try {
      this.vmm.copyout(proc.pd, ptr, out);
    } catch (e) {
      if (!(e instanceof BadAddress)) throw e;
      proc.fds[rfd] = null;
      proc.fds[wfd] = null;
      return ERR;
    }
    return 0;
  }

  // dup(fd): return the lowest free fd referring to the same open file.
  private sysDup(proc: Process, fd: number): number {
    const of = proc.fds[fd];
    if (!of) return ERR;
    const nfd = proc.fds.indexOf(null);
    if (nfd === -1) return ERR;
    of.ref++;
    proc.fds[nfd] = of;
    return nfd;
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
    this.closeFile(of);
    proc.fds[fd] = null;
    return 0;
  }

  // Drop one reference to an open file. When the last reference goes away, a pipe
  // end closes: closing the write end wakes blocked readers with EOF.
  private closeFile(of: OpenFile): void {
    of.ref--;
    if (of.ref > 0 || of.kind !== 'pipe' || !of.pipe) return;
    if (of.writable) {
      of.pipe.writers--;
      if (of.pipe.writers === 0) this.servicePipeReaders(of.pipe);
    } else {
      of.pipe.readers--;
    }
  }

  // --- process model: fork / exec / wait / exit ---

  // Duplicate `parent` into a new process with a copied address space. Both
  // resume just after the trapping INT; the caller wires up the return values.
  private fork(parent: Process): Process {
    const pd = this.vmm.cowCloneAddressSpace(parent.pd);
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
  private sysExec(proc: Process, pathPtr: number, argvPtr: number): number {
    let path: string;
    let argv: string[];
    try {
      path = this.vmm.copyinStr(proc.pd, pathPtr);
      argv = this.copyinArgv(proc, argvPtr);
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
    const { sp, argvPtr: argvVec, argc } = this.setupUserStack(pd, argv);
    this.vmm.freeAddressSpace(proc.pd);
    proc.pd = pd;
    proc.name = path;
    Object.assign(proc.cpu, this.userState(pd, entry, sp));
    proc.cpu.regs[0] = argc;
    proc.cpu.regs[1] = argvVec;
    return 0; // overwritten by the new image anyway
  }

  // Read an argv vector (user array of string pointers, NULL-terminated) into JS
  // strings. argvPtr == 0 means no arguments.
  private copyinArgv(proc: Process, argvPtr: number, max = 32): string[] {
    if (argvPtr === 0) return [];
    const argv: string[] = [];
    for (let i = 0; i < max; i++) {
      const word = this.vmm.copyin(proc.pd, argvPtr + i * 4, 4);
      const ptr = (word[0]! | (word[1]! << 8) | (word[2]! << 16) | (word[3]! << 24)) >>> 0;
      if (ptr === 0) break;
      argv.push(this.vmm.copyinStr(proc.pd, ptr));
    }
    return argv;
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
    // Release every open file descriptor (pipe ends close, waking EOF readers).
    for (let fd = 0; fd < proc.fds.length; fd++) {
      const of = proc.fds[fd];
      if (of) this.closeFile(of);
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

// Pop up to `n` bytes from the front of a byte array into a Uint8Array.
function take(buffer: number[], n: number): Uint8Array {
  return new Uint8Array(buffer.splice(0, Math.min(n, buffer.length)));
}

// Write a 32-bit little-endian value into a 4-byte buffer.
function writeWord(buf: Uint8Array, v: number): void {
  const u = v >>> 0;
  buf[0] = u & 0xff;
  buf[1] = (u >>> 8) & 0xff;
  buf[2] = (u >>> 16) & 0xff;
  buf[3] = (u >>> 24) & 0xff;
}
