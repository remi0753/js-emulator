# Devices, Roadmap & Design Decisions

## Devices (added incrementally)

- **Console**: v1 writes to `process.stdout` via the `WRITE` syscall. v2 makes it
  a port-mapped tty driven by a kernel driver.
- **Timer**: v1 has no real timer — the quantum stands in for it. v2 adds a
  programmable PIT that drives preemption and the clock.
- **Keyboard**: v2 adds an input ring buffer + IRQ and a blocking `read`.
- **Block disk**: v2 adds a 512-byte-sector disk backed by host `disk.img`,
  carrying the filesystem (persistent across runs).

Future devices should be added in the order that makes the VM more useful as an
OS target, not in the order that a physical PC happens to expose them:

1. **Serial console / debug port**: deterministic early boot output, panic logs,
   and scriptable test I/O.
2. **Interrupt controller + timer**: a real in-VM IRQ delivery path instead of
   host-side scheduler callbacks.
3. **Block devices**: keep the simple PIO disk, then add a DMA/virtio-like disk
   once the guest kernel can manage buffers and interrupts.
4. **Framebuffer + keyboard/mouse**: enough for a graphical console after the
   text shell is stable.
5. **RTC / entropy / power control**: small devices that make boot, timestamps,
   shutdown, and tests more realistic.
6. **Network device**: only after the guest kernel has a stable interrupt,
   buffer, and process model; networking will otherwise hide lower-level bugs.
7. **Host bridge devices**: optional development aids such as snapshot/restore,
   trace collection, or a controlled host-file import/export device.

## Roadmap

### v1 — register machine + cooperative-ish multitasking ✅

1. ✅ `src/v1/cpu.ts` — memory + CPU + ISA table + `run`/`loadContext`/`saveContext`
2. ✅ `src/assembler.ts` — mnemonics -> bytecode (with label resolution)
3. ✅ unit tests — arithmetic, branching, `WRITE`, `HLT` for a single process
4. ✅ `src/v1/os.ts` — PCB / round-robin scheduler / `handleSyscall` / loader
5. ✅ demo — two processes interleaving output (preemptive multitasking works)

### v2 — Unix-like OS (see [v2.md](v2.md))

Goal: xv6-style OS — paging MMU, real traps/interrupts, port I/O, a filesystem
on a host-backed disk, and a Unix process model with a shell.

**Acceptance target (definition of done for v2):** boot the kernel, reach an
interactive **shell**, and run **`ls`** to list the files and directories on the
mounted `disk.img`. Reaching this exercises every v2 layer end to end — paging,
traps/syscalls, the scheduler, the block driver, the filesystem/VFS, file
descriptors, `fork`/`exec`, and userland.

- **Phase 1** ✅ CPU privilege levels + paging MMU + trap/fault/IRQ model +
  `IN`/`OUT` port I/O (with tests for translation, page faults, privilege traps).
- **Phase 2** ✅ TS kernel core on the virtual HW: physical & virtual memory
  managers, timer-driven preemptive scheduler, syscall dispatch, console driver;
  user-mode programs syscall and get preempted (see `src/v2/kernel/`).
- **Phase 3** ✅ process model: `fork`/`exec`/`wait`/`exit`, ELF-like loader,
  multiple user programs (see `src/formats/executable.ts` + the process syscalls in
  `kernel.ts`; demo `node demo/v2-fork-exec.ts`).
- **Phase 4** ✅ storage: block driver over `disk.img`, on-disk FS (superblock,
  inodes, block bitmap, direct + indirect blocks, directories), file descriptors,
  `open`/`read`/`write`/`close`, exec from the FS (see `src/vm/custom32/devices/disk.ts`,
  `src/storage/{port-block-device,fs}.ts`; demo `node demo/v2-fs.ts`).
- **Phase 5** ✅ userland: `init`, a shell, and coreutils (`echo`, `cat`, `ls`),
  all hand-written guest assembly; `exec` delivers `argv`; byte load/store (`LB`/
  `SB`) added to the ISA for string code (see `src/v2/userland/programs.ts`; demo
  `node demo/v2-shell.ts`). **This reaches the v2 acceptance target: boot → shell
  → `ls` lists the disk.** Commands are fed on stdin (pre-keyboard); **pipes** move
  to Phase 6 since they need the same blocking I/O as the keyboard.
- **Phase 6** ✅ polish: a **keyboard** device with **blocking I/O** (read blocks
  until a key is pressed), **pipes** (`pipe`/`dup`) with blocking, **copy-on-write
  `fork`** (shared read-only frames, COW page-fault handler, frame refcounts), and
  more syscalls (`uptime`). See `src/vm/custom32/devices/keyboard.ts`, COW in
  `src/v2/kernel/{pmm,vmm}.ts`; demos `node demo/v2-pipe.ts`, interactive
  `node demo/v2-shell.ts`. **v2 is feature-complete.**

### Final target — Node.js VM + Linux-like guest OS

The long-term target is a Node.js-hosted virtual machine that can load a disk
image, boot a guest kernel from that disk, run user programs from the filesystem,
and interact through virtual devices. At that point TypeScript is no longer "the
kernel"; TypeScript is the machine: CPU, memory, MMU, interrupt delivery, device
models, tracing, and host integration. The OS itself is guest code.

This is a stricter goal than v2. v2 already has real user/kernel protection for
user programs, but its kernel is still TypeScript. The final target requires the
kernel to execute inside the VM in privileged mode, handle traps itself, drive
devices through the same hardware interface exposed by the VM, and load its own
userland from the disk image. Beyond that, the goal is to make the guest OS as
Linux-like as is practical on a Node.js VM: not binary-compatible with Linux at
first, but close in its process model, syscall semantics, VFS behavior, memory
management, device model, observability, and userland expectations.

The acceptance target for the first fully guest-run system:

- `node ... disk.img` starts a VM from a persistent disk image.
- A boot path loads a guest kernel from the disk or from a boot partition.
- The guest kernel switches on paging, installs trap/IRQ handlers, mounts the
  root filesystem, starts `/bin/init`, and reaches a shell.
- The shell can run at least `ls`, `cat`, `echo`, and a pipeline from binaries on
  the disk.
- The TypeScript side can be reset to "hardware only": no scheduler, VFS,
  process table, or syscall handlers outside the guest.
- Tests can run the VM headlessly and assert on serial output, disk contents,
  traps, and process exit behavior.

After that target is reached, compatibility should advance in tiers:

- **Tier 1: Unix-like semantics** — familiar process, file, pipe, directory,
  terminal, and signal behavior; enough to run a small shell environment.
- **Tier 2: Linux-like kernel surface** — Linux-shaped syscalls and error codes,
  `mmap`, `poll`, `ioctl`, `/dev`, `/proc`, permissions, and enough metadata for
  real tools to make sense.
- **Tier 3: Linux-like userland** — a libc layer and a broader coreutils-style
  userland compiled for this ISA, with scripts, redirection, pipelines, and
  build tools.
- **Tier 4: Linux compatibility experiments** — optional ABI translation or a
  Linux-syscall personality for selected statically linked programs compiled to
  this ISA. Running unmodified Linux binaries is not a near-term goal because the
  ISA is custom, not x86_64/ARM64/RISC-V.

The practical compatibility target is therefore "Linux-like OS on a custom
Node.js VM", not "Linux kernel running unmodified". To run the actual Linux
kernel, the VM would need to emulate a real architecture and device platform
such as RISC-V virt or x86 PC, which is a different project.

### v3 — model B foundation: kernel becomes guest code

v3 is the transition from v2's "TS kernel on real virtual hardware" model to a
real guest kernel. The main risk is trying to port everything at once. The right
shape is to first make the VM capable of running a tiny guest kernel, then move
subsystems over one at a time.

- **Phase 7** ✅ split the VM from the TypeScript kernel.

  Defined a narrow `Machine` boundary that owns only hardware state: CPU, physical
  memory, MMU, port bus, devices, pending interrupts, and `load`/`reset`/`run`/
  `raiseIrq` operations (see `src/vm/custom32/machine.ts`). The `Kernel` remains a
  compatibility harness — it still constructs/accepts a `Machine` — but model-B
  work boots straight through the hardware boundary with no kernel. Added
  deterministic VM tracing (`src/vm/custom32/trace.ts`): an instruction trace, a
  trap/return trace, a port I/O trace, a disk I/O trace, and page-table dumps
  (`dumpPageTable` in `mmu.ts`), all wired through optional zero-overhead hooks on
  the CPU/port bus/disk. Demo `node demo/v2-machine.ts`; tests in
  `test/machine.test.ts`.

  Done: a test creates a blank machine, loads guest bytes at a physical address,
  runs until a trap/halt, and inspects only hardware-visible state (registers,
  physical RAM, disk) — no scheduler, process table, or syscall dispatch.

- **Phase 8** ✅ implement real in-CPU trap and interrupt entry.

  When a guest installs an interrupt descriptor table (`LIDT`), the CPU now enters
  guest kernel mode in-CPU on a trap instead of returning to the host: it switches
  to the kernel stack (`LKSP` / esp0), pushes a trap frame (user sp / flags / mode
  / return pc), jumps to the vector's handler in KERNEL mode with interrupts
  masked, and the handler returns with `IRET`. Software `INT n`, CPU exceptions
  (divide/illegal/GP via fixed vectors), and device/timer IRQs all take the same
  IDT vector path; page faults save `PFLA` (CR2-like) and an x86-style error code
  (`RDPFLA`/`RDERR`). An in-CPU timer (`STMR`) delivers IRQ0 through the vectors.
  With no IDT installed the CPU keeps the model-A behaviour of returning to the
  host, so the v2 kernel is unaffected. New ISA: `LIDT`/`LKSP`/`IRET`/`RDPFLA`/
  `RDERR`/`STMR` (all privileged); see `src/isa.ts` (`TRAP`/IDT constants) and
  `src/vm/custom32/cpu.ts`. Demo `node demo/v2-trap.ts`; tests in
  `test/trap.test.ts`.

  Done: a guest kernel written in assembly installs handlers, receives `INT 0x80`
  and returns with `IRET`, recovers from a user page fault (handler maps the page
  and the faulting instruction retries), and preempts a user loop through a timer
  IRQ — all with no TypeScript scheduler or syscall dispatch. A fault during trap
  delivery (e.g. an unmapped kernel stack) is reported as a double fault.

- **Phase 9** ✅ define a boot path and disk-image contract.

  Added a boot-sector convention: sector 0 (the boot block the FS already
  reserves) holds a manifest — magic + boot-sector signature, the filesystem
  superblock location, a raw kernel-image region (`kernelStart`/`kernelBlocks`
  plus load/entry/size/stack metadata), and the path of the program to start as
  init (see `src/formats/bootblock.ts`). The maintained image layout is
  `[boot block | superblock | inodes | bitmap | data | raw guest kernel]`; the
  kernel region is outside the filesystem size so allocation cannot overwrite it.
  `Kernel.boot()` reads the manifest and starts the named init — a manifest-driven
  handoff, not a hard-coded path. The image builder is now first-class:
  `buildDiskImage()` / `tools/mkimg.ts` (`npm run build:img`) formats the FS,
  installs userland, seeds files, and writes the boot block; `bootImage()` /
  `tools/boot.ts` (`npm run boot`) mounts an image and boots it. Tests in
  `test/boot.test.ts`.

  Done: `node tools/mkimg.ts` builds `disk.img`, then `node tools/boot.ts` boots
  it to a shell and runs `ls` — the boot path calls neither `installUserland()`
  nor `spawnFromFile()`; the userland lives on the disk and the manifest names
  init.

- **Phase 10** ✅ build the guest-kernel toolchain.

  Raw assembly is enough for tiny trap handlers, but not for a kernel. Add a
  C-like language or a small systems language targeting the existing ISA. Minimum
  features: integers, pointers, arrays, structs, functions, stack frames,
  conditionals, loops, global data, inline assembly or intrinsic port I/O, and a
  freestanding runtime (`crt0`, memcpy/memset/string helpers, no host libc).
  Add a linker that can produce kernel images and user executables with separate
  text/data/bss segments.

  Implemented a freestanding C-like compiler and linker in `src/toolchain/`.
  The compiler supports integers, chars, pointers, arrays, structs, functions,
  software stack frames, conditionals, loops, global data, string literals,
  inline assembly statements, and privileged/kernel or syscall intrinsics such
  as `__out`, `__in`, `__syscall`, `__lidt`, `__lksp`, `__stmr`, `__iret`, and
  `__halt`. It emits guest assembly plus symbol/source-map metadata. The linker
  resolves cross-section symbols and emits the existing executable format with
  separate RX text and RW data/BSS segments, or a flat loadable kernel image.
  It preserves function-prototype types across object boundaries, rejects
  duplicate public text/data/BSS symbols instead of silently choosing one, and
  validates kernel-image segment placement so text and data cannot overlap.
  A freestanding runtime provides `memcpy`, `memset`, `strlen`, and `strcmp`;
  `crt0` initializes the compiler's software stack and calls `main` or `kmain`.

  Done: `test/toolchain.test.ts` compiles and runs a non-trivial user program
  using structs, arrays, pointers, loops, globals, strings, runtime helpers, and
  syscalls, links multiple objects with shared runtime helpers, verifies
  cross-object pointer-return prototypes and duplicate-symbol failures, then
  compiles a tiny guest kernel that writes through port I/O and halts on the
  hardware-only `Machine`.

- **Phase 11** ✅ boot a minimal guest kernel.

  Phases 11–16 describe historical milestones, not parallel maintained
  implementations. Their completed source snapshots remain available in Git
  history. The maintained implementation is `src/v3/kernel/kernel.c`, built by
  `src/v3/guest-kernel.ts`; current regression tests are organized by subsystem
  rather than phase.

  Start with the smallest real kernel: serial output, panic, page-table setup,
  trap table setup, a physical frame allocator, and a simple idle loop. It does
  not need processes yet. The purpose is to prove that the VM can run privileged
  guest code that owns the trap path.

  Added a compiled guest kernel using the Phase 10 toolchain and ran it directly
  on the hardware-only `Machine`. The kernel writes to
  the serial console, has a `panic` that reports and halts, installs its own IDT
  (every vector points at a default panic handler before the timer/page-fault
  gates overwrite theirs, so it owns the whole trap path), builds an
  identity-mapped page table, enables paging from guest code (`LPTBR`/`PGON`), and
  runs a bump physical frame allocator. Its page-fault handler reads the faulting
  address (`RDPFLA`), allocates a frame, maps the page, and lets the CPU retry the
  access; it also arms the in-CPU timer, handles timer IRQ0 through the guest IDT,
  and stays in an idle loop. The trap stubs are assembly that save the
  caller-clobbered registers and call into C handlers.

  Done: the guest kernel prints through a device, enables paging, handles a timer
  interrupt, handles a deliberate page fault, and keeps running.

- **Phase 12** ✅ move memory management and scheduling into the guest.

  Extended the Phase 11 guest kernel with a memory manager and scheduler that run
  entirely in guest code. The guest kernel lives in a real `.c` source file;
  `guest-kernel.ts` keeps the memory-layout/ISA constants as the single source
  of truth and substitutes them into the `CFG_*` tokens in those files at build
  time (a tiny no-macro/no-include preprocessor). A free-list **PMM** (frames threaded through their own
  free pages) replaces the bump allocator. The **VMM** builds a per-process page
  directory whose entry 0 shares one identity-mapped kernel page table (so kernel
  code/data/stacks/frame-pool keep their addresses in every address space) and
  whose user range is private; `map_page` allocates page tables on demand.
  Process state lives in opaque guest memory (flat per-process arrays of
  registers/pc/sp/flags/mode/ptbr); `setup_process` builds an address space and
  loads the user image, and `fork_process` duplicates an address space by copying
  frames (**fork without COW**). User mode is entered by building a trap frame and
  `IRET`ing into it. The guest **timer IRQ handler** spills the interrupted
  registers and trap frame into the current PCB, round-robins to the next
  process, reloads its context, and switches `ptbr` (`__lptbr`) before `IRET` —
  a full context switch with no TypeScript scheduler. The timer period is sized
  above the handler cost so user code makes progress between ticks.

  Done: three guest user processes (two independent plus a fork of the first) run
  in isolated address spaces — same user virtual addresses, distinct physical
  frames and page directories — and are preempted and round-robined purely by the
  guest-handled timer interrupt; TypeScript only ever reads opaque physical
  memory.

- **Phase 13** ✅ move syscalls and process lifecycle into the guest.

  Extended the Phase 12 guest kernel with the full syscall ABI handled entirely
  in guest code: `exit`, `write`, `read`, `yield`, `getpid`, `fork`, `exec`, and
  `wait`. The CPU only ever delivers `INT 0x80` (a new IDT vector alongside the
  timer and page-fault gates); the guest **syscall handler** stub spills the
  caller's registers/trap frame into the current PCB, and a C dispatcher decodes
  `R0` (number) / `R1`–`R3` (args), reads user memory safely (bound-checked to
  the user range, read directly because the caller's page directory is still
  live), updates process state, sets the `R0` return value, and `IRET`s. A real
  process **lifecycle** (runnable / zombie / blocked) backs `exit`/`wait`:
  `exit` turns a process into a zombie and wakes a blocked parent; `wait` reaps
  a zombie child or blocks until one exits; `fork` returns 0 to the child and
  the child pid to the parent; `exec` rebuilds the caller's address space from a
  second embedded image. The scheduler round-robins only runnable processes and
  halts the VM once all have exited. Address-space frees (exec's old image, a
  reaped child) happen only after switching `ptbr`, so the kernel never frees
  the page directory it is translating through.

  Done: a guest user program (`init`) forks a child, the child `exec`s a second
  image and prints through the `write` syscall, and `init` `wait`s for it and
  prints — `fork`, `exec`, `wait`, and `print` all run with no TypeScript
  syscall dispatch (TypeScript only delivers the trap).

- **Phase 14** ✅ move storage and the filesystem into the guest.

  Extended the Phase 13 guest kernel with a read path for the on-disk filesystem,
  handled entirely in guest code over the unchanged block-disk port protocol. A
  guest **PIO block driver** reads 512-byte blocks through the disk ports; a
  small **FIFO buffer cache** sits in front of it. On top of that the kernel
  ports the xv6-flavored FS read path: superblock **mount**, **inode** reads,
  **block mapping** (`bmap`: direct + single-indirect), file reads (`readi`),
  **directory lookup**, and absolute **path resolution** (`namei`). Processes
  get **per-process file descriptors** with `open`/`read`/`close` syscalls
  (inherited across `fork`, preserved across `exec`), extending the Phase 13
  ABI. **Executable loading** comes from the filesystem: both `exec` and the
  boot path resolve a path, read the file, and load it into a fresh address
  space. At boot the kernel mounts the disk, reads the boot block's manifest to
  learn which program is init (honoring the Phase 9 handoff), loads that file,
  and runs it — no embedded user image. The Phase 14 disk image is built with
  the existing `Fs`/`PortBlockDevice` against a `BlockDisk`, installing flat
  assembled `/bin/init` and `/bin/hello` plus a seed `/etc/motd`.

  Done: the guest kernel mounts the disk image, loads `/bin/init` from the
  filesystem and `exec`s it from guest code; init opens, reads, and prints
  `/etc/motd` through file descriptors, then forks a child that `exec`s
  `/bin/hello` (also loaded from the FS) and waits for it — TypeScript only
  models the disk device and delivers traps.

- **Phase 15** ✅ rebuild userland for the guest OS.

  Replaced the hand-written assembly userland with compiled C. A small **libc**
  (`src/v3/userland/libc.c`) provides syscall stubs (`write`/`read`/`open`/
  `close`/`fork`/`exec`/`wait`/`exit`/`getpid`/`pipe`/`dup`) over the `INT 0x80`
  ABI, and `init`, `sh`, `echo`, `cat`, and `ls` are compiled C linked against
  it. To support a real userland the guest kernel adds: **executable loading**
  from a flat header
  (magic / entry / memSize) plus a multi-page text+data+bss image (not a single
  code page); **argv passing** (`exec(path, argv)` copies the argument strings
  and `argv[]` array onto the new process's user stack and enters
  `main(argc, argv)`); a **unified file-descriptor table** where each fd is the
  console, the keyboard, an open file, or a pipe end; and **`pipe`/`dup`** with a
  blocking pipe (readers block and re-run the syscall when woken, with
  reference-counted ends for EOF). The shell forks/execs commands (searching
  `/bin`), waits for them, and wires `cmd | cmd` with `pipe` + the
  `close`/`dup`-to-lowest-fd idiom. The userland is compiled and installed onto
  the disk image at build time; the v2 assembly programs remain as low-level
  regression tests (`test/userland.test.ts`). Current end-to-end coverage is in
  `test/guest-userland.test.ts`.

  Done: a freshly built disk image contains compiled `/bin/init`, `/bin/sh`,
  `/bin/echo`, `/bin/cat`, and `/bin/ls`; booting it reaches the shell, which
  runs `ls /`, `cat /etc/motd`, `echo hi`, and the pipeline
  `cat /etc/motd | cat` — all compiled C executing on the guest with no
  TypeScript userland.

- **Phase 16** ✅ expand devices behind stable guest drivers.

  Established the device-extension pattern (a hardware device model on the port
  bus, a guest driver function, and a syscall that exposes it) and used it to add
  two simple, deterministic devices on top of the existing serial/timer/keyboard/
  PIO-disk set. A **real-time clock** (`src/vm/custom32/devices/rtc.ts`) is a
  read-only port returning the wall-clock time as a Unix timestamp; its source is
  injectable (`Machine`'s `rtcTime`) so tests are deterministic. A **power
  controller** (`src/vm/custom32/devices/power.ts`) is a write-only port: writing
  `POWER_OFF` asserts a power-off line that the `Machine` wires to a new
  `cpu.powerOff()`, so `run()` stops cleanly at the next instruction boundary —
  a real software power-off instead of halting only when nothing is runnable.
  The guest kernel adds the matching drivers and two syscalls
  (`time`/`shutdown`), the libc gains `time()`/
  `shutdown()` wrappers, and the userland gains compiled `/bin/date` (prints the
  RTC time) and `/bin/shutdown` (powers off). Demo `node demo/v3.ts`;
  hardware-level tests in `test/devices.test.ts`, guest-driver + integration
  tests in `test/guest-devices.test.ts`.

  The guest syscall boundary validates user mappings and permissions before
  access, `exec` failures return to the caller without panicking, software
  interrupts honor user-callable IDT gates, keyboard and pipe waits idle until
  an IRQ/readiness change, and short pipe writes are retried by userland.

  Done: each new device has a hardware-level test (the RTC returns the configured
  time; an `OUT` of `POWER_OFF` halts the CPU), a guest driver test, and an
  integration demo that boots the compiled userland from disk, runs `/bin/date`
  to read the RTC, and runs `/bin/shutdown` to power the machine off through the
  power device — all compiled C driving the new hardware on the guest.

### v4 — Linux-like kernel and userland behavior

Once the kernel is running as guest code, the next horizon is Linux-like
behavior. This means building the surfaces that programs expect from a Unix/Linux
system: process groups, signals, file metadata, terminals, `/dev`, `/proc`,
memory mappings, permissions, polling, and a coherent libc. The priority is
semantic compatibility for programs compiled for this VM's ISA, not bit-for-bit
compatibility with the Linux kernel.

#### Implementation strategy for v4 and later

Phase numbers are development milestones, not separate kernel versions. Continue
to evolve the single maintained kernel in `src/v3/kernel/`; preserve completed
milestones with Git tags such as `phase-17-complete` rather than copying the
kernel source. Tests and demos should be named after the subsystem or behavior
they verify, for example `guest-signals.test.ts`, `guest-vfs.test.ts`, and
`guest-mmap.test.ts`.

Before adding Phase 17 features, split the current monolithic `kernel.c` by
subsystem. **Status:** the split is done — the kernel now compiles as separate
subsystem objects (`main.c`, `trap.c`, `scheduler.c`, `process.c`, `exec.c`,
`syscall.c`, `memory.c`, `file.c`, `pipe.c`, `fs.c`, and `drivers/{console,
keyboard,disk,rtc,power}.c`) that share `kernel.h` and link into one image
(`src/v3/guest-kernel.ts`). The toolchain gained the shared-declaration support
this needed: `extern` globals in the C compiler and a `#include` preprocessor
(`src/toolchain/preprocess.ts`); see `test/toolchain.test.ts`. The remaining
kernel-internal foundations below (errno, copyin/copyout, wait queues,
table-driven dispatch, structured state, and `file_ops`) are now complete. The
maintained file shape is:

```text
src/v3/kernel/
  main.c
  kernel.h
  trap.c
  process.c
  scheduler.c
  syscall.c
  memory.c
  exec.c
  file.c
  pipe.c
  fs.c
  drivers/
    console.c
    keyboard.c
    disk.c
    rtc.c
    power.c
```

`src/v3/guest-kernel.ts` should compile each source file separately and link the
resulting objects into one kernel image. Add the minimum toolchain support needed
for shared declarations first: headers or an equivalent include mechanism,
function prototypes, structs, constants, and cross-object type checking. Avoid
duplicating declarations and configuration values across C files.

Establish these kernel-internal foundations during that split:

- ✅ stable negative errno values and a libc-visible `errno` convention
  (config.ts `ERRNO`; libc `errno` + `ret_errno`);
- ✅ `copyin`/`copyout`/`copyinstr` helpers as the normal path for user-memory
  access (memory.c);
- ✅ a shared sleep/wakeup and wait-queue primitive (scheduler.c `sleep`/
  `wakeup`, channels are object addresses; one `CFG_ST_SLEEPING` state);
- ✅ table-driven syscall dispatch (syscall.c `syscall_table`), enabled by a new
  register-indirect call (`CALLR`) in the ISA and function-pointer support in
  the C compiler;
- ✅ structured process, file, inode/vnode, pipe, and VM state instead of
  parallel flat arrays (`proc_table` owns each process's context, VM space, and
  descriptor objects; descriptors reference shared open-file descriptions so
  `dup`/`fork` share offsets; `pipe_table` owns each pipe's buffer and endpoint
  counts);
- ✅ a common `file_ops`-style interface for files/directories, pipes, terminal
  input, and console/device output. `read`/`write`/`close`/`retain` dispatch
  through per-file operation tables, so syscall handlers no longer branch on
  descriptor type.

The phases below have dependencies and should not be implemented as isolated
feature lists. Use this practical order:

1. **Kernel structure and error/wait foundations** — modularize the kernel,
   introduce errno, safe user copies, wait queues, and syscall tables.
2. **Signals and the minimum TTY foundation** — implement signal delivery,
   masks, `sigreturn`, and `waitpid`, then process groups, sessions, foreground
   terminal groups, and Ctrl-C delivery. Phase 17 job control depends on part of
   Phase 21 and should be developed with it.
3. **File abstraction, metadata, and VFS** — introduce file/vnode operations
   before expanding metadata calls, then add `stat`, directory mutation,
   permissions, `/dev`, `/proc`, and tmpfs. This covers Phases 19–21 without
   hard-coding each new object type into syscall handlers.
4. **Virtual-memory areas** — implement `brk`, VMAs, lazy anonymous allocation,
   `mmap`/`munmap`, `mprotect`, copy-on-write, file-backed mappings, and a page
   cache. The `mmap` calls listed in Phase 18 depend on this Phase 22 foundation
   and should not be implemented as ad hoc mappings.
5. **libc and userland** — add `malloc`, stdio, directory, signal, terminal, and
   environment APIs after the corresponding kernel interfaces stabilize.
6. **Polling and networking** — build nonblocking I/O and `poll` on the shared
   wait queues and `file_ops` readiness interface. Validate a deterministic UDP
   path before adding TCP.
7. **Driver model, observability, C toolchain, then SMP** — consolidate devices
   behind VFS and driver interfaces, make failures diagnosable, then stabilize
   custom32 as a real C target before adding multi-core. SMP should wait until
   single-core process, VFS, VM, signal, driver, and toolchain semantics are
   stable enough to make concurrency failures isolatable.

For every milestone, use the same completion workflow:

1. document the syscall ABI, data structures, and important state transitions;
2. add focused kernel or hardware tests;
3. add a minimal guest user program that exercises the feature;
4. add a shell-level end-to-end test where appropriate;
5. run type checking, linting, and the complete test suite;
6. update this roadmap and tag the completed commit.

- **Phase 17** ✅ complete the process and signal model.

  Added guest-owned signal state and delivery (`src/v3/kernel/signal.c`):
  `kill`, caught/default/ignored actions, blocked masks, a libc signal
  dispatcher and `sigreturn` restorer, and `EINTR` returns when a signal wakes a
  process blocked in a syscall. `SIGKILL`/`SIGSTOP` cannot be caught; default
  actions terminate, stop, continue, or ignore as appropriate. `exec` resets
  caught actions while `fork` inherits actions and masks.

  Processes now carry process-group and session IDs. The kernel implements
  `setpgid`, `setsid`, terminal foreground-group operations, group-directed
  signals, and `waitpid` selectors/options with exit, stop, and continue status
  reporting. The keyboard driver buffers TTY input and converts Ctrl-C into
  `SIGINT` for the foreground process group.

  The compiled shell creates a session, assigns each command or pipeline its own
  process group, transfers the terminal for foreground jobs, supports trailing
  `&` background jobs, reaps them without blocking, and survives foreground
  interrupts. `/bin/spin` provides a deterministic CPU-bound foreground job for
  integration testing. Coverage is in `test/guest-signals.test.ts`.

  Done: the shell launches foreground/background jobs, Ctrl-C terminates a
  foreground job without terminating the shell, caught and blocked signals
  return through `sigreturn`, interrupted pipe reads report `EINTR`, and
  `waitpid` observes stopped/continued children before reaping their final exit.

- **Phase 18** ✅ add Linux-shaped syscall conventions and errno behavior.

  The raw guest ABI now consistently returns stable negative Linux errno values,
  and libc translates them to `-1` plus a positive global `errno`. Added
  `getppid`, `nanosleep`, `brk`/`sbrk`, `mmap`, `munmap`, `mprotect`, `fcntl`,
  `ioctl`, `gettimeofday`, `clock_gettime`, `uname`, and `getdents`; the Phase 17
  `waitpid` implementation remains the process-wait interface.

  Memory mappings are tracked as per-process VM areas rather than one-off page
  table edits. The Phase 18 implementation eagerly allocates anonymous private
  mappings and eagerly reads private file-backed mappings; `fork` copies their
  pages and VMA metadata. `mprotect` updates user/write permissions and
  `munmap` handles whole, trimmed, and split areas. Lazy faults, shared
  write-back, COW mappings, and the page cache remain Phase 22 work.

  `fcntl` provides descriptor duplication, close-on-exec, and status/descriptor
  flag queries. `ioctl` exposes the existing foreground process-group terminal
  operations through Linux request numbers. `getdents` returns a stable
  libc-visible directory-entry structure, and `/bin/ls` now uses it instead of
  parsing raw on-disk entries. The compatibility table is maintained in
  `docs/syscalls.md`; end-to-end coverage is in
  `test/guest-linux-abi.test.ts`.

  Done: compiled userland uses libc wrappers for normal process, file,
  directory, memory, time, and terminal operations, with specific errno values
  observable on every failure path.

- **Phase 19** ✅ implement permissions, credentials, and file metadata.

  The on-disk inode format now persists Linux-shaped mode, uid/gid, link count,
  size, and atime/mtime/ctime fields alongside direct/indirect block pointers.
  The superblock records filesystem version 2 and the inode size so older images
  fail explicitly instead of being interpreted with the new layout.
  The guest filesystem is writable through its PIO disk driver and buffer cache:
  it allocates/frees blocks and inodes, writes/truncates files, updates
  directories, and preserves mutations in `disk.img`. The root filesystem tracks
  mount flags and is mounted read/write; write paths consistently reject a
  read-only mount.

  Added single-user root credentials to each process (inherited by `fork`) with
  permission checks and `getuid`/`getgid`. The Linux-shaped syscall/libc surface
  includes `stat`, `fstat`, `lstat`, `chmod`, `chown`, `mkdir`, `rmdir`,
  `unlink`, `link`, `rename`, `symlink`, `readlink`, and `lseek`. Hard links
  share inode/link state, unlinked-but-open files survive until final close,
  relative and absolute symlinks are traversed with a bounded loop depth, and
  directory renames maintain `..` and parent link counts. `/bin/ls -l` displays
  type/mode, link count, ownership, size, and symlink targets.

  Coverage is in `test/guest-file-metadata.test.ts`, including a second boot from
  the same mutated disk image. Done: metadata, directory creation/removal,
  renames, hard/symbolic links, traversal, file offsets, and `ls -l` behavior
  remain predictable across reboots.

- **Phase 20** ✅ add a real VFS layer and pseudo filesystems.

  Added a guest-owned mount table and vnode operation interface in
  `src/v3/kernel/vfs.c`. The root disk filesystem, devfs at `/dev`, procfs at
  `/proc`, and tmpfs at `/tmp` now share the same path lookup, vnode,
  open-file-description, `file_ops`, `stat`, `getdents`, and descriptor paths.
  Executable loading also reads through vnodes instead of calling the disk
  filesystem directly.

  devfs exposes `/dev/console`, `/dev/null`, and `/dev/zero`; the initial
  process's standard descriptors are ordinary opens of the console vnode.
  procfs exposes `/proc/self`, numeric `/proc/<pid>` directories, and dynamic
  `status` files. The fixed-size in-memory tmpfs supports create, read, write,
  seek, stat, chmod/chown, unlink, and reset-on-reboot behavior. Mountpoint
  directories are present in generated disk images, while their contents come
  from the mounted pseudo filesystems.

  Coverage is in `test/guest-vfs.test.ts`. Done: device nodes, process
  inspection paths, and temporary files open and operate through the same VFS
  path as persistent disk files.

- **Phase 21** ✅ implement terminal and TTY semantics.

  Add canonical/raw input modes, echo, line discipline, terminal window size,
  Ctrl-C/Ctrl-D/Ctrl-Z handling, and enough `ioctl` behavior for shells and text
  programs. Keep serial console as the early boot/debug path, but expose a proper
  TTY device to userland.

  Added a guest-owned TTY line discipline between the keyboard driver and
  devfs. `/dev/tty` (and the compatible `/dev/console` node) supports canonical
  line buffering, raw input, echo and erase/kill editing, configured control
  characters, foreground process groups, Ctrl-C/Ctrl-Z signals, Ctrl-D EOF,
  host-input close, and blocking reads. Linux-shaped `TCGETS`/`TCSETS*`,
  `TIOCGWINSZ`/`TIOCSWINSZ`, and foreground-group ioctls are exposed through
  libc terminal helpers. The shell uses the TTY for standard descriptors and
  supports basic `<` and `>` redirection without host-side input processing.

  Done when the shell can run interactively with line editing behavior, EOF,
  interrupts, job-control signals, and redirection without host-side special
  cases.

- **Phase 22** ✅ upgrade memory management toward Linux behavior.

  VMAs now retain mapping protections, private/shared mode, backing open-file
  objects, and file offsets independently of descriptors. Anonymous mappings
  and `brk` growth reserve address space without allocating frames; user faults
  allocate zero-filled pages or demand-read file pages. A guard page below the
  fixed user stack is excluded from executable images, heap growth, and
  mappings.

  `fork` shares present frames and marks private pages copy-on-write, including
  the executable image, stack, anonymous mappings, and private file mappings.
  Shared file mappings use a guest-kernel page cache, remain physically shared
  across `fork`, become dirty on the first write fault, and are written back on
  unmap/address-space teardown or cache eviction. `mprotect` operates on lazy
  VMAs as well as resident pages, while `munmap` trims/splits VMAs and releases
  backing-file references. Kernel `copyin`/`copyout` also resolve valid lazy and
  COW pages rather than incorrectly returning `EFAULT`.

  The guest libc now provides `malloc`, `free`, and `calloc` over lazy `sbrk`.
  End-to-end coverage in `test/guest-vm-phase22.test.ts` verifies large lazy
  mappings, anonymous COW isolation, shared file visibility and write-back,
  guard-page `SIGSEGV`, and libc heap allocation.

  Done: programs allocate through libc `malloc`, map and share files across
  `fork`, preserve private mappings with COW, and fault anonymous/file pages in
  lazily.

- **Phase 23** ✅ build a libc and Linux-like userland ABI.

  Added a shared public userland header and expanded the guest libc from syscall
  stubs into a coherent C/POSIX-style layer: startup publishes `environ`;
  `execve` carries `envp` through the kernel startup ABI; environment mutation,
  heap allocation/reallocation, unbuffered `FILE` stdio, string/memory helpers,
  path helpers, `DIR` iteration, time, signal, and terminal APIs are available
  to compiled programs. The linker now removes unreachable label sections from
  user executables so a broad static libc does not make every utility pay for
  the whole library.

  The maintained programs include the shared libc header instead of duplicating
  ABI structures. The shell supports quoted tokens, exported environment
  variables, script files and `ENOEXEC` script fallback, redirection,
  foreground/background jobs, and pipelines of up to four commands. The image
  adds `wc`, `head`, `grep`, `mkdir`, `rm`, `mv`, `ln`, `touch`, `env`, a libc
  test runner, `/etc/rc`, `/etc/profile`, a package manifest, and the executable
  `/bin/selftest` shell script.

  Coverage in `test/guest-libc-phase23.test.ts` boots the image, propagates an
  exported variable through `exec`, runs text tools and a three-command
  pipeline, executes the self-test script, and exercises stdio, directory,
  environment, and path APIs.

  Done: normal maintained user programs are written against libc, and a fresh
  disk image boots into a shell environment with scripts, pipelines, init
  files, core file/text tools, and a guest-side test runner.

- **Phase 24** ✅ add polling and asynchronous I/O foundations.

  Implement `select`/`poll`-style readiness over files, pipes, terminals, and
  network sockets once networking exists. Add nonblocking file descriptor flags,
  wakeup queues, and a consistent wait/sleep primitive in the kernel.

  Done when a user program can multiplex stdin, pipes, timers, and sockets
  without busy-waiting.

  Implemented a shared file readiness interface for regular files, TTYs, pipes,
  and sockets; `O_NONBLOCK` through `fcntl(F_SETFL)`; and `poll` with immediate,
  infinite, or tick-based timeout waits. Pollers sleep on the existing
  wait-channel scheduler primitive and are woken by TTY, pipe, socket, and
  timeout state changes rather than spinning. End-to-end coverage is in
  `test/guest-io-phase24.test.ts`.

  Done: guest programs can combine terminal, pipe, and socket descriptors in a
  poll set, use nonblocking reads/writes, and wait for a timeout without
  busy-waiting.

- **Phase 25** ✅ add networking with a Linux-like socket API.

  Add a simple NIC device, deterministic packet injection tests, ARP if using
  Ethernet, IPv4, ICMP, UDP, and a minimal TCP stack. Expose sockets through
  Linux-like calls: `socket`, `bind`, `listen`, `accept`, `connect`, `send`,
  `recv`, `setsockopt` where needed, and readiness through `poll`.

  Done when the guest can run a small TCP or UDP service and a host-side test can
  exchange packets with it deterministically.

  Added a deterministic PIO Ethernet NIC with host packet injection and captured
  transmit queues. The guest owns Ethernet framing, ARP replies, IPv4 parsing,
  ICMP echo replies, and UDP delivery. UDP sockets are ordinary descriptors and
  support `socket`, `bind`, `connect`, `send`, `recv`, `sendto`, `recvfrom`,
  `setsockopt`, nonblocking mode, and `poll`; stream-oriented entry points
  (`listen`/`accept`) are present and report that TCP is not yet supported.
  The maintained guest address is `10.0.2.15` with MAC `02:00:00:00:00:02`.
  End-to-end coverage in `test/guest-network-phase25.test.ts` boots a UDP
  service, injects an Ethernet frame after it blocks in `poll`, and verifies the
  reply frame emitted by the guest.

  Done: a host-side test exchanges UDP packets with a guest service
  deterministically through the virtual NIC and guest network stack.

- **Phase 26** ✅ add a Linux-like device and driver model.

  Keep early devices simple, but organize them behind a driver model: device
  enumeration, major/minor numbers, char/block device operations, IRQ ownership,
  DMA-safe buffers if DMA is introduced, and a `/sys`-like inspection surface if
  useful. Add framebuffer, mouse, RTC, entropy, power/shutdown, and virtio-like
  block/network devices in that framework.

  Added a guest-owned device/driver model in `src/v3/kernel/device.c`. Character
  devices are now kernel objects registered with a major number, a name,
  permission bits, and a `read`/`write` operation table; devfs resolves `/dev`
  names through this registry and dispatches reads/writes to the owning driver
  instead of a hard-coded switch. `console`, `null`, `zero`, and `tty` keep their
  historical object ids (so `vnode_is_tty` and existing `/dev` ordering stay
  stable) but are now ordinary registrations, joined by new `rtc`, `random`, and
  `urandom` nodes. `stat` reports `S_IFCHR` plus a `major:minor` `rdev`. A new
  deterministic entropy device (`src/vm/custom32/devices/entropy.ts`, a seeded
  xorshift on its own port) backs `/dev/random` and `/dev/urandom`.

  Device interrupts are routed the same way: a driver claims its line with
  `request_irq`, and the per-line assembly trap stub funnels through
  `irq_dispatch`, which invokes the registered handler (`keyboard_isr`,
  `network_drain`). The timer keeps its dedicated scheduler stub. A `/sys`
  pseudo-filesystem (mounted at `/sys`) exposes the registry for inspection:
  `/sys/devices` lists registered char devices and their majors, and `/sys/irq`
  lists owned IRQ lines and their owning drivers. End-to-end coverage is in
  `test/guest-devices-phase26.test.ts`; the framework is ready for adding the
  remaining devices (framebuffer, mouse, virtio-like block/network) as further
  registrations.

  Done: devices are no longer ad hoc port users but kernel objects visible
  through `/dev`, the shared VFS file operations, IRQ routing, and driver
  registration — a guest program reads the RTC and entropy char devices, `ls
  /dev` enumerates every registered driver, `/sys` reports the device and IRQ
  registries, and keyboard input still arrives through the routed IRQ.

- **Phase 27** ✅ add observability and debugging surfaces.

  Added a guest-owned kernel log and runtime tracing in `src/v3/kernel/klog.c`.
  `klog()` records kernel messages into a bounded in-memory buffer and mirrors
  them to the serial console, so boot, exec, shutdown, panic, and trace output
  are captured both host-side (serial) and guest-side. The buffer is exposed as
  the `/dev/kmsg` character device (registered through the Phase 26 driver
  model), and `/bin/dmesg` reads it. `panic()` now dumps the offending process
  context (pid/pc/sp/mode) through the log before halting.

  A runtime trace bitmask is toggled by writing the writable `/sys/trace`
  control file (syscall=1, disk=2, fault=4). When the syscall bit is set the
  dispatcher logs each call as `trace: pid=N name(a1, a2, a3) = rv` with
  symbolic names for the headline syscalls; the page-fault handler and the PIO
  block driver emit fault and disk-read/write trace lines under their bits.

  Process state and address-space inspection moved into procfs: enriched
  `/proc/<pid>/status` reports Pid/PPid/State/Pgid/Sid/Uid/Gid, and a new
  `/proc/<pid>/maps` dumps the heap span and every resident VM area with its
  protection bits. `/bin/ps` lists processes by reading procfs. The existing
  host-side deterministic traces (`src/vm/custom32/trace.ts`) remain the
  emulator-level path. Coverage is in `test/guest-observability-phase27.test.ts`.

  Done: a failing guest run can be diagnosed from the kernel log (`/dev/kmsg` /
  `dmesg` / serial), syscall and disk traces toggled through `/sys/trace`, and
  process state and page-table/VMA dumps under `/proc`, with no emulator
  instrumentation — a guest program reads the log, toggles tracing, inspects its
  own status and maps, and `dmesg`/`ps` surface the same data from the shell.

### v5 — C toolchain and self-hosting path

The next priority is making custom32 a real C target before introducing SMP.
The goal is not to grow the current TypeScript C-like compiler into full C
feature by feature. Instead, use a small, proven C compiler frontend such as
[chibicc](https://github.com/rui314/chibicc), replace its x86-64 backend with a
custom32 backend, and bootstrap from a host cross-compiler toward a compiler
that runs inside the guest.

Keep the first implementation deliberately small: static linking, no
optimization, no PIC, no dynamic loader, no TLS, and soft-float rather than an
FPU. The intended pipeline is:

```text
chibicc tokenizer / preprocessor / parser / type checker
    -> custom32 code generator
    -> custom32 assembler
    -> custom32 static linker
    -> guest executable
```

- **Phase 28** ✅ stabilize custom32 as a real C target.

  Before SMP, make the single-core machine a dependable target for ordinary C.
  Audit and fix the ISA semantics that C depends on: signed overflow-aware
  comparisons, unsigned comparisons, division/remainder, arithmetic right shift,
  sign-extending byte/halfword loads, and runtime helper conventions for
  64-bit integer and soft-float operations.

  Freeze a documented ILP32 custom32 C ABI in `docs/custom32-c-abi.md`:
  `char=1`, `short=2`, `int/long/pointer=4`, `long long=8`, `float=4`, and
  `double=8`; argument order and stack layout; caller/callee-saved registers;
  32-bit and 64-bit returns; hidden-pointer returns for large structs; stack
  alignment; struct/union/enum/bit-field layout; function pointers; variadic
  traversal; symbol visibility; relocation types; syscall boundary
  expectations; and executable/linker assumptions.

  Prefer one ABI stack based on the hardware `SP`. The current compiler's
  software `__csp` is useful for bootstrapping, but retaining two stack
  conventions would complicate `va_list`, `alloca`, debugging, and
  interoperability.

  Added the frozen ILP32 ABI contract in `docs/custom32-c-abi.md`, covering type
  sizes/alignment, the hardware-`SP` call stack, caller/callee-saved registers,
  scalar and aggregate returns, struct/union/enum/bit-field layout, variadic
  traversal, symbol/relocation expectations, runtime helper conventions, and the
  syscall boundary. The document explicitly marks the current TypeScript C-like
  compiler's `__csp` stack as bootstrap-only and records the migration path to a
  single hardware-stack ABI.

  Audited and tightened the C-dependent ISA surface: `CMP` now records signed
  overflow (`OF`) and signed branches use `SF xor OF`; unsigned branches
  (`JA`/`JAE`/`JB`/`JBE`) use `CF`/`ZF`; signed `IDIV`/`IMOD`, arithmetic `SAR`,
  sign-extending byte/halfword loads (`LBS`/`LHS`), zero-extending halfword load
  (`LH`), and halfword store (`SH`) are available alongside existing unsigned
  `DIV`/`MOD` and logical `SHR`. The bootstrap compiler now emits `IDIV`/`IMOD`
  for signed `int` `/`/`%` and `SAR` for `int >>`.

  Coverage is in `test/custom32-abi-phase28.test.ts`. Done: ABI documentation
  exists, focused ISA/ABI tests cover signed overflow comparisons, unsigned
  order, signed/unsigned division and shifts, sign-extending loads, and the
  existing compiler path has a documented migration path away from its
  bootstrap-only conventions.

- **Phase 29** ✅ define object files, archives, and host assembler/linker tools.

  Made the project object format explicit. A relocatable object
  (`src/formats/object.ts`, magic `OBJ1`) carries text/data/bss sections, a
  symbol table (local/global/undefined/abs symbols), an `abs32` relocation
  table, and a string table, serialized in deterministic order. Static archives
  (`src/formats/archive.ts`, magic `AJR1`) hold ordered object members and back
  on-demand library search. A relocatable assembler
  (`src/toolchain/as.ts`) turns assembly into objects — every label becomes a
  symbol and every identifier operand an `abs32` relocation — with `.text`/
  `.data`/`.bss`/`.global`/`.word`/`.byte`/`.string`/`.space` directives and
  `name+N` addends. The object linker (`src/toolchain/object-linker.ts`)
  resolves globals/undefineds, pulls archive members to a fixed point, lays out
  sections at concrete addresses, applies relocations, and emits either the
  guest loadable header or the generic JEX container. An object/archive dumper
  (`src/toolchain/dump.ts`) renders sections, symbols, and relocations.

  Turned these pieces into command-line host tools — `custom32-as`,
  `custom32-ld`, `custom32-ar`, and `custom32-objdump` (`tools/custom32-*.ts`,
  also `npm run as|ld|ar|objdump` and `bin` entries) — supporting multiple
  translation units, static archives, `-L`/`-l` library search, absolute
  code/data relocations, and executables consumable by the guest loader. The
  format and tools are documented in `docs/custom32-objfmt.md`.

  Done: `test/object-toolchain-phase29.test.ts` assembles hand-written `puts`/
  `putdigit` helpers into `libio.a`, links `/bin/child` and `/bin/hello` against
  it (pulling only the needed members), dumps the objects/archive, installs the
  executables into a disk image, boots the guest, and verifies that `hello`
  forks/execs `child` and reports its decoded exit status (`child exited 7`) —
  exercised both in-process and through the four CLIs.

- **Phase 30** ✅ add a host `custom32-cc` driver and ABI smoke suite.

  Add a `custom32-cc` host driver that can compile, assemble, link, search
  libraries, and optionally install a guest executable into a disk image. Use the
  current compiler only as a bootstrap input while the real C frontend is being
  ported.

  Build an ABI smoke suite before changing the real frontend. It should compile
  and run tiny programs covering calls, globals, pointers, structs, arrays, libc
  calls, multiple translation units, archives, startup code, argv/envp where
  relevant, and exit status reporting.

  Added the `custom32-cc` driver (`tools/custom32-cc.ts`, `npm run cc`, `bin`
  entry) over a reusable core (`src/toolchain/cc.ts`) plus a guest-target glue
  module (`src/v3/guest-cc.ts`). The driver compiles `.c`, assembles `.s`,
  accepts `.o`/`.a` inputs, searches libraries with `-L`/`-l`, links through the
  Phase 29 object pipeline, and optionally installs the executable into a disk
  image (`--install`/`--install-as`). A C translation unit is lowered to a
  relocatable object by re-emitting the bootstrap compiler's assembly through the
  same `as.ts` assembler the `.s` path uses, so cross-object calls/globals/pointer
  initializers resolve as ordinary `abs32` relocations. To avoid duplicate
  startup/runtime symbols, units are compiled with no startup and no runtime and
  reference `__csp`/`memcpy`/… as undefined symbols; a single shared
  `crt0Object()` defines `_start`, the software stack, `environ`, and the runtime
  helpers, and is linked first unless `-nostartfiles` is given. The toolchain core
  stays OS-generation independent (the layering test forbids `toolchain/` →
  `v3`); the guest load base, executable magic, and disk install live in
  `src/v3/guest-cc.ts`. Documented in `docs/custom32-cc.md`.

  Done: `test/cc-abi-phase30.test.ts` is the ABI smoke suite — it covers calls,
  globals, pointers, a struct-pointer argument, arrays, archived libc calls,
  multiple translation units, startup code, argv/envp delivery, and exit status.
  Its end-to-end case host-compiles and links a multi-file program against a
  static archive, installs it into a disk image, boots the guest, runs it from the
  shell, and asserts both the program's stdout (`compute=117`, the child's
  `argv[0]`/`environ[0]`) and the decoded child exit status (`child exited 7`) —
  exercised both in-process and through the `custom32-cc` CLI.

- **Phase 31** ✅ import a real C frontend and land the first custom32 backend
  slice.

  Vendor or mirror the chosen chibicc revision in a clearly isolated toolchain
  directory. Preserve upstream tests where practical, and keep local custom32
  changes separate from imported frontend code. Reuse the tokenizer, macro
  preprocessor, parser, type checker, constant evaluation, initializer handling,
  and C11 declarators.

  Replace the target-dependent pieces: type sizes and alignment, assembly
  emission, register use, calls, variadic calls, aggregate arguments/returns,
  relocations, global initializers, `va_list`, target builtins, and predefined
  target macros. The first backend slice only needs integer expressions, local
  variables, `if`, `while`, function calls, global data, string literals, and
  `return`.

  Added a real C frontend in the isolated `src/toolchain/chibicc/` directory: a
  TypeScript port of chibicc's architecture (Rui Ueyama, MIT), structured to
  mirror upstream's file split — `tokenize.ts`, `preprocess.ts`, `type.ts`,
  `parse.ts` — with the target-dependent pieces split out into `codegen.ts`, the
  custom32 backend. The whole project implements its CPU/OS/toolchain in
  TypeScript and has no host C compiler in its pipeline, so chibicc is ported
  rather than vendored as buildable C; `PROVENANCE.md` records the mapping, the
  slice scope, and the ABI decision. The frontend (tokenizer, minimal object-like
  macro preprocessor, parser, `add_type`) is target independent; the only
  target-specific surfaces are the ABI type sizes in `type.ts` (sourced from
  `docs/custom32-c-abi.md`) and all of `codegen.ts`.

  The Phase 31 slice covers integer expressions (arithmetic/bitwise/shift/
  comparison/logical/unary), `int`/`char`/`void` with pointers and arrays, local/
  parameter/global variables, string and character literals, `if`/`while`/`for`/
  `break`/`continue`/`return`/blocks, function definitions, prototypes, and direct
  calls, plus the `__syscall` intrinsic for libc-free programs. Pointer-arithmetic
  scaling and `a[i]` desugaring happen in the parser (chibicc's `new_add`/
  `new_sub`), so the backend never reasons about element sizes. `codegen.ts` emits
  the same software-stack ABI as the bootstrap compiler, so chibicc objects
  assemble through `as.ts` and link against the existing, tested `crt0Object()`
  startup/runtime and bootstrap libc through the Phase 29 object pipeline. The
  host driver gains a `custom32-cc --frontend chibicc` switch that swaps just the
  `.c` compilation while reusing the whole assemble/link/install flow; the
  hardware-`SP` ABI migration in `docs/custom32-c-abi.md` remains future work.

  Done: `test/chibicc-phase31.test.ts` compiles `int main(void) { return 42; }`
  with the host-built chibicc compiler, assembles and links it, installs it as
  `/bin/ret42`, boots the guest, and a chibicc-compiled launcher (exercising
  globals, char arrays, pointer indexing, `while`/`if`, the operator set, calls,
  string literals, and `__syscall`) forks/execs it, waits, and reports the decoded
  exit status `ret42 exited 42` — exercised both in-process and through the
  `custom32-cc --frontend chibicc` CLI.

- **Phase 32** ⬜ broaden C language support for real programs.

  Bring language support up in dependency order: the real preprocessor;
  typedef/enum/struct/union; linkage and storage classes; complex declarators;
  initializers; integer promotions; `long long`; variadic functions; aggregate
  calls/returns; bit-fields; compound literals; VLAs; then `float`/`double`
  through soft-float helpers. `_Atomic`, TLS, PIC, and dynamic linking can
  remain unsupported during the bootstrap.

  Add compiler tests at four levels where useful: frontend/compiler unit tests,
  ABI boundary tests, differential tests against GCC/Clang, and execution tests
  inside the VM. Cover integer limits, overflow-sensitive comparisons, shifts,
  aggregate padding, bit-field boundaries, variadic arguments, relocations, and
  soft-float edge cases.

  First maintained slice implemented in this branch: the chibicc-derived frontend
  now accepts `typedef`, enum constants and constant expressions, `struct`/
  `union` definitions (including forward `typedef struct T T;` style tags),
  aggregate member layout, `sizeof(type-name)` and `sizeof(expression)`,
  `.`/`->` member access, scalar/aggregate/string initializers, and short
  load/store codegen. It also supports function-pointer typedef declarators
  such as `typedef int (*op)(int, int)`, function-name decay to code addresses,
  and indirect calls through variables or array elements using `CALLR`. Coverage
  is in `test/chibicc-phase32.test.ts`, including a guest-executed program that
  exercises typedefs, enums, struct padding, aggregate globals/locals,
  char-array string initialization, member access, 16-bit fields, and
  function-pointer dispatch through the VM.

  Done when the host cross-compiler can build a broad set of small C conformance
  and regression programs for custom32 and run them deterministically inside the
  guest.

- **Phase 33** ⬜ expand the guest libc and build environment for compiler-sized
  programs.

  The compiler needs a broader libc than ordinary userland tools. Provide
  compiler-facing headers and APIs including `stddef.h`, `stdint.h`, `limits.h`,
  `errno.h`, `stdarg.h`, a reliable allocator and enough heap/address space,
  binary stdio with seek/buffering/error handling, `printf`/`fprintf`/`snprintf`
  with real variadic arguments, integer parsing, ctype, environment and path
  helpers, `open`/`read`/`write`/`close`/`stat`, temporary files, and enough
  process execution to run build steps.

  Increase the development VM from the default 16 MiB RAM and 1 MiB disk when
  building large translation units. Start around 64-128 MiB RAM and a disk large
  enough for sources, objects, archives, and temporary files. An arena allocator
  that can discard a whole translation unit at once keeps the compiler simple.

  Done when compiler-sized guest programs can parse files, allocate large
  translation-unit state, emit temporary/output files, and report errors through
  libc without exhausting the default development environment.

- **Phase 34** ⬜ make the compiler runnable inside the guest.

  Cross-compile the compiler as a guest executable, install it with its headers
  and libraries into the disk image, and run it on small source files stored in
  the guest filesystem. Port assembler/linker tools into userland, or provide an
  in-process assembler/linker library usable by the guest compiler.

  Keep instruction budgets, disk images, input files, and external events
  deterministic so failed compiler runs replay exactly.

  Done when the guest compiler compiles and runs small C programs inside the OS,
  without relying on host-side compilation after boot.

- **Phase 35** ⬜ bootstrap the compiler and climb real packages.

  Use a conventional three-stage bootstrap:

  ```text
  host GCC/Clang builds the custom32 cross-compiler
      -> stage 0 emits the guest-native compiler
      -> stage 1 runs in the guest and rebuilds itself
      -> stage 2 rebuilds itself again for comparison
  ```

  Stage-1 and stage-2 outputs should be reproducible or normalize to the same
  result. After that, let compiler test failures and attempts to compile real
  software determine the next missing feature. Start with tiny libraries, then
  zlib/libpng, then SQLite.

  Done when the guest compiler rebuilds itself at least once, the rebuild can be
  replayed deterministically, and the package climb has a documented failure
  queue rather than ad hoc missing-feature notes.

- **Phase 36** ⬜ rebuild guest OS artifacts from inside the guest.

  Use the guest compiler and guest build tools to rebuild meaningful parts of
  the system: userland utilities first, then the guest kernel or a kernel module.
  Export the produced artifact, boot it in a new VM run, and verify it with the
  normal guest tests.

  Done when a guest-built utility and a guest-built kernel artifact can be
  produced in one VM run, booted or executed in another VM run, and verified
  against host-built equivalents where comparison is meaningful.

- **Phase 37** ⬜ make the self-hosting development loop reproducible.

  Record the initial disk image, source inputs, generated objects, external
  events, instruction budgets, host tool versions, emulator settings, and
  artifact export paths. The loop should cover disk-image build, emulator boot,
  guest tests, compiler bootstrap, package-build attempts, artifact export, and
  host-side verification.

  Done when a failed bootstrap or package build can be replayed exactly, and a
  successful run produces a manifest that explains every generated artifact.

### v6 — SMP after single-core and toolchain semantics are solid

SMP remains valuable, but it should not be the next destabilizing step after the
single-core Linux-like surface. The pre-SMP bar is not full self-hosting, but the
roadmap now makes the compiler path explicit before SMP so ABI and userland bugs
can be exposed without concurrency in the way.

- **Phase 38** ⬜ add multi-core only after single-core semantics are solid.

  SMP requires atomic instructions in the ISA, spinlocks, per-CPU state,
  scheduler changes, timer routing, TLB shootdown semantics, and careful driver
  locking. Add this after signals, VFS, VMAs, core device behavior,
  observability, and the C toolchain are stable, otherwise concurrency will make
  basic bugs much harder to isolate.

  Done when two or more virtual CPUs can run user processes concurrently while
  filesystem, pipes, signals, page faults, self-hosted toolchain workloads, and
  compiled C user programs remain correct.

## Design decisions

- Register machine (R0–R7 + PC/SP/FLAGS), 32-bit, little-endian.
- Variable-length instructions; one ISA table shared by CPU and assembler.
- **The CPU's `run(maxCycles)` always returns to JS in v1/v2 model A** — so the
  kernel (TS) does time slicing and trap handling in the host. Model B keeps
  `run()` as the host execution boundary, but traps should enter guest kernel
  code before the VM returns to the host except for debugging, reset, or fatal
  machine stops.
- **Kernel in TS, hardware real (v2 model A)**: user programs are guest bytecode
  in user mode; privilege separation, paging, traps and port I/O are enforced by
  the virtual CPU. A self-hosted guest kernel (model B) needs CPU trap-entry
  machinery, a boot path, and a compiler/toolchain; it is out of scope for v2 but
  is the explicit v3+ direction.
- **Linux-like over Linux-compatible**: because the ISA is custom, the practical
  goal is to build a Linux-like OS surface for programs compiled for this VM.
  Running the real Linux kernel or unmodified Linux binaries would require
  emulating a real Linux-supported architecture and platform, which should be
  treated as a separate emulator project.
- **Paging MMU** (two-level, 4 KiB pages) for per-process virtual address spaces
  — chosen over BASE/LIMIT segmentation for realism.
- **Port-mapped I/O** (`IN`/`OUT`) for devices; **host-file-backed disk** for a
  persistent filesystem.

## Ideas / unscheduled explorations

Not on the roadmap yet — parking lot for things worth trying later.

### Host display as a VM device (framebuffer / "monitor")

Expose the host's screen to the guest as a graphics device, modeled like a real
VGA/framebuffer: a memory-mapped VRAM region plus a few control ports. The guest
writes pixels into VRAM and the host paints them on an actual display.

- **Hardware contract (in the VM).** Reserve a region of physical RAM as VRAM
  (e.g. `FB_BASE`, 320×200×8bpp ≈ 64 KiB); the guest maps it via the MMU and
  writes pixels with plain `write8`. The framebuffer is *not* routed through the
  byte-at-a-time `PortBus` — only control goes there: a `FB_CTL` port for
  mode-set (resolution/bpp) and a `FB_FLUSH` port that, on `OUT`, asks the host
  to present the current frame (guest-driven vsync). Wire a `Display` device in
  `machine.ts` the same way the keyboard is wired (`display.onFlush = () =>
  host.paint(phys.bytes, FB_BASE, …)`), mirroring the `power.onPowerOff`
  callback pattern. Optionally add a `VSYNC_IRQ` so present-complete returns to
  the guest as an interrupt (same path as `KEYBOARD_IRQ`). Since `phys.bytes` is
  a shared `Uint8Array`, the host reads the frame with no copy.
- **Host-side painter (reaching a real screen from Node).** Three backends, in
  recommended order: (1) **browser + WebSocket + `<canvas>`** — zero native deps,
  free resolution/color, and `keydown`/`mousemove` can be sent back over WS into
  `keyboard.feed()` / a new mouse device → `raiseIrq`, giving input too; (2)
  **terminal graphics** (Kitty/Sixel, or `▀` half-blocks + 24-bit ANSI) — stays
  in the existing terminal, no extra process, low-res; (3) **native window** via
  an SDL2 binding (e.g. `@kmamal/sdl`) — most "real monitor"-like, but pulls in a
  native build dependency.
- **Determinism note.** Keep guest-driven `FB_FLUSH` as the primary present path
  so draw timing is decided by the guest's instruction stream and stays
  reproducible in traces (consistent with the instruction-counted timer IRQ). A
  wall-clock `setInterval` refresh is acceptable only if it *reads* VRAM and
  never mutates VM state.
- **Smallest viable slice.** `Display` device (~30 lines) + VRAM reservation in
  physical RAM + a tiny `ws` server (~40 lines) + a `<canvas>` client page is
  enough to get the guest drawing to the host screen.
