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
  superblock location, a reserved raw kernel-image region (`kernelStart`/
  `kernelBlocks`, empty until model B has a guest kernel to load), and the path of
  the program to start as init (see `src/formats/bootblock.ts`). The stable disk
  layout is `[boot block | superblock | inodes | bitmap | data (/bin/* + files)]`.
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
7. **Driver model, observability, then SMP** — consolidate devices behind VFS
   and driver interfaces, make failures diagnosable, and add multi-core only
   after single-core process, VFS, VM, signal, and driver semantics are stable.

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

- **Phase 20** ⬜ add a real VFS layer and pseudo filesystems.

  Generalize filesystem operations behind vnode/inode/file abstractions so the
  kernel can mount multiple filesystem types. Add `/dev` for device nodes, a
  `devpts`-like terminal namespace if pseudo terminals are added, `/proc` for
  process and kernel inspection, and tmpfs for temporary files. Device access
  should go through normal file operations wherever possible.

  Done when `/dev/console`, `/dev/null`, `/dev/zero`, `/proc/self`, `/proc/<pid>`,
  and tmpfs files can be opened through the same VFS path as disk files.

- **Phase 21** ⬜ implement terminal and TTY semantics.

  Add canonical/raw input modes, echo, line discipline, terminal window size,
  Ctrl-C/Ctrl-D/Ctrl-Z handling, and enough `ioctl` behavior for shells and text
  programs. Keep serial console as the early boot/debug path, but expose a proper
  TTY device to userland.

  Done when the shell can run interactively with line editing behavior, EOF,
  interrupts, job-control signals, and redirection without host-side special
  cases.

- **Phase 22** ⬜ upgrade memory management toward Linux behavior.

  Add VM areas (VMAs), lazy allocation, demand paging, guard pages, page cache,
  file-backed `mmap`, anonymous `mmap`, copy-on-write mappings, `mprotect`, and
  user heap growth through `brk`/`sbrk`. This is the point where the memory
  manager stops being only a loader/page-table helper and starts behaving like a
  Unix VM subsystem.

  Done when programs can allocate memory through libc `malloc`, map files,
  share mapped pages across `fork`, and fault pages in lazily.

- **Phase 23** ⬜ build a libc and Linux-like userland ABI.

  Create a libc layer for this OS/ISA: syscall wrappers, `crt0`, `malloc`,
  stdio, string/memory functions, environment variables, path helpers, directory
  iteration, time, signal wrappers, and terminal helpers. Then build a larger
  userland: shell, coreutils-like tools, text tools, init scripts, test runner,
  and package/image build helpers.

  Done when normal user programs are written against libc instead of raw
  assembly syscall snippets, and a disk image can boot into a usable shell
  environment with scripts and pipelines.

- **Phase 24** ⬜ add polling and asynchronous I/O foundations.

  Implement `select`/`poll`-style readiness over files, pipes, terminals, and
  network sockets once networking exists. Add nonblocking file descriptor flags,
  wakeup queues, and a consistent wait/sleep primitive in the kernel.

  Done when a user program can multiplex stdin, pipes, timers, and sockets
  without busy-waiting.

- **Phase 25** ⬜ add networking with a Linux-like socket API.

  Add a simple NIC device, deterministic packet injection tests, ARP if using
  Ethernet, IPv4, ICMP, UDP, and a minimal TCP stack. Expose sockets through
  Linux-like calls: `socket`, `bind`, `listen`, `accept`, `connect`, `send`,
  `recv`, `setsockopt` where needed, and readiness through `poll`.

  Done when the guest can run a small TCP or UDP service and a host-side test can
  exchange packets with it deterministically.

- **Phase 26** ⬜ add a Linux-like device and driver model.

  Keep early devices simple, but organize them behind a driver model: device
  enumeration, major/minor numbers, char/block device operations, IRQ ownership,
  DMA-safe buffers if DMA is introduced, and a `/sys`-like inspection surface if
  useful. Add framebuffer, mouse, RTC, entropy, power/shutdown, and virtio-like
  block/network devices in that framework.

  Done when devices are not ad hoc port users but kernel objects visible through
  `/dev`, VFS operations, IRQ routing, and driver registration.

- **Phase 27** ⬜ add observability and debugging surfaces.

  Linux-like systems are debuggable from inside and outside. Add kernel logs,
  panic backtraces, symbolized traces, process state dumps, page-table dumps,
  syscall tracing, disk/network tracing, and a `/proc` or debugfs-style surface.
  Keep host-side deterministic traces for emulator tests.

  Done when a failing guest test can be diagnosed from serial logs, syscall
  traces, process state, and filesystem/device traces without manually
  instrumenting the emulator.

- **Phase 28** ⬜ add multi-core only after single-core semantics are solid.

  SMP requires atomic instructions in the ISA, spinlocks, per-CPU state,
  scheduler changes, timer routing, TLB shootdown semantics, and careful driver
  locking. Add this after signals, VFS, VMAs, and core device behavior are
  stable, otherwise concurrency will make basic bugs much harder to isolate.

  Done when two or more virtual CPUs can run user processes concurrently while
  filesystem, pipes, signals, and page faults remain correct.

### v5 — self-hosting stretch goal

Self-hosting means the system can rebuild meaningful parts of itself inside the
guest OS. This is intentionally last: it depends on the compiler, filesystem,
process model, shell, and enough memory management to run build tools.

- **Phase 29** ⬜ port assembler/linker tools into userland.
- **Phase 30** ⬜ run the compiler inside the guest, first compiling small
  programs, then userland utilities.
- **Phase 31** ⬜ rebuild the guest kernel or a kernel module inside the guest and
  boot the produced artifact in a new VM run.
- **Phase 32** ⬜ make the development loop reproducible: disk image build,
  emulator boot, guest tests, artifact export, and host-side verification.

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
