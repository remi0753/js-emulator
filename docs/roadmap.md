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
  multiple user programs (see `src/v2/kernel/exec.ts` + the process syscalls in
  `kernel.ts`; demo `node demo/v2-fork-exec.ts`).
- **Phase 4** ✅ storage: block driver over `disk.img`, on-disk FS (superblock,
  inodes, block bitmap, direct + indirect blocks, directories), file descriptors,
  `open`/`read`/`write`/`close`, exec from the FS (see `src/vm/custom32/devices/disk.ts`,
  `src/v2/kernel/{disk,fs}.ts`; demo `node demo/v2-fs.ts`).
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
  the program to start as init (see `src/v2/kernel/bootblock.ts`). The stable disk
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

- **Phase 10** ⬜ build the guest-kernel toolchain.

  Raw assembly is enough for tiny trap handlers, but not for a kernel. Add a
  C-like language or a small systems language targeting the existing ISA. Minimum
  features: integers, pointers, arrays, structs, functions, stack frames,
  conditionals, loops, global data, inline assembly or intrinsic port I/O, and a
  freestanding runtime (`crt0`, memcpy/memset/string helpers, no host libc).
  Add a linker that can produce kernel images and user executables with separate
  text/data/bss segments.

  Done when a non-trivial guest program and a tiny guest kernel can be compiled,
  linked, loaded, and debugged from source maps or symbol tables.

- **Phase 11** ⬜ boot a minimal guest kernel.

  Start with the smallest real kernel: serial output, panic, page-table setup,
  trap table setup, a physical frame allocator, and a simple idle loop. It does
  not need processes yet. The purpose is to prove that the VM can run privileged
  guest code that owns the trap path.

  Done when the guest kernel prints through a device, enables paging, handles a
  timer interrupt, handles a deliberate page fault, and keeps running.

- **Phase 12** ⬜ move memory management and scheduling into the guest.

  Port or rewrite PMM/VMM inside the guest kernel. Then add process structures,
  per-process page tables, context switching, user-mode entry, timer-driven
  preemption, `fork` without COW first, then COW once the page fault path is
  stable. TypeScript should not know about process state except as opaque memory.

  Done when two guest user processes run in isolated address spaces and are
  preempted by guest-handled timer interrupts.

- **Phase 13** ⬜ move syscalls and process lifecycle into the guest.

  Implement the syscall ABI in the guest kernel: `exit`, `write`, `read`,
  `yield`, `getpid`, `fork`, `exec`, `wait`, and later `pipe`/`dup`. The CPU
  should only deliver `INT 0x80`; the guest kernel must decode registers, copy
  user memory safely, update process state, and return with `IRET`.

  Done when a guest user program can `fork`, `exec`, `wait`, and print without
  any TypeScript syscall dispatch.

- **Phase 14** ⬜ move storage and the filesystem into the guest.

  Keep the existing block-disk device protocol initially. Port the block driver
  and filesystem code into the guest kernel, including path lookup, inode/block
  allocation, file descriptors, and executable loading. Add a buffer cache before
  adding more complex devices; it will be needed for performance and correctness
  once concurrent processes access the disk.

  Done when the guest kernel mounts the disk image, loads `/bin/init` from the
  filesystem, and `exec`s it from guest code.

- **Phase 15** ⬜ rebuild userland for the guest OS.

  Replace hand-written assembly programs with compiled userland where practical:
  libc-style syscall stubs, `init`, shell, `echo`, `cat`, `ls`, and pipe-aware
  command execution. Preserve the assembly programs as low-level regression
  tests, but make normal userland part of the disk-image build.

  Done when a fresh disk image contains compiled `/bin/init`, `/bin/sh`, and
  utilities, and the shell can run `ls /`, `cat file`, `echo hi`, and
  `cat file | cat`.

- **Phase 16** ⬜ expand devices behind stable guest drivers.

  Add devices only after the guest kernel has a clear driver boundary. Suggested
  order: serial console, PIT/timer, keyboard, PIO disk, framebuffer, mouse, RTC,
  virtio-like block, virtio-like net, and optional host bridge devices. Prefer
  simple deterministic devices first; add DMA and asynchronous behavior only when
  the guest has the memory and interrupt infrastructure to test them.

  Done when each new device has a hardware-level test, a guest driver test, and
  at least one integration demo that boots from disk and exercises it.

### v4 — Linux-like kernel and userland behavior

Once the kernel is running as guest code, the next horizon is Linux-like
behavior. This means building the surfaces that programs expect from a Unix/Linux
system: process groups, signals, file metadata, terminals, `/dev`, `/proc`,
memory mappings, permissions, polling, and a coherent libc. The priority is
semantic compatibility for programs compiled for this VM's ISA, not bit-for-bit
compatibility with the Linux kernel.

- **Phase 17** ⬜ complete the process and signal model.

  Add `kill`, `signal`/`sigaction`-style handlers, default signal actions,
  blocked signal masks, interrupted syscalls, process groups, sessions, and
  terminal foreground process groups. Extend `wait` into `waitpid`-like behavior
  and track stopped/continued children. This is required before an interactive
  shell can behave like a real Unix shell rather than a command loop.

  Done when the shell can launch foreground/background jobs, interrupt a
  foreground job with Ctrl-C, reap children correctly, and keep running.

- **Phase 18** ⬜ add Linux-shaped syscall conventions and errno behavior.

  Replace the current coarse `-1` failures with stable negative errno values or
  a libc-visible `errno`. Add Linux-like calls where they matter: `getppid`,
  `waitpid`, `nanosleep`, `brk`, `mmap`, `munmap`, `mprotect`, `fcntl`, `ioctl`,
  `gettimeofday`/`clock_gettime`, `uname`, and `getdents`-style directory reads.
  Keep a compatibility table documenting which Linux calls are implemented,
  stubbed, or intentionally unsupported.

  Done when userland can use libc wrappers instead of hard-coded raw syscall
  stubs for normal process, file, time, and terminal operations.

- **Phase 19** ⬜ implement permissions, credentials, and file metadata.

  Add uid/gid, mode bits, ownership, timestamps, links, `stat`, `fstat`,
  `lstat`, `chmod`, `chown` if multi-user support is desired, `mkdir`, `rmdir`,
  `unlink`, `link`, `rename`, `symlink`/`readlink`, `lseek`, and mount flags.
  The first pass can be single-user but should preserve Linux-shaped metadata so
  tools do not need special cases.

  Done when `ls -l`-style metadata, directory creation/removal, renames, links,
  and path traversal behave predictably across reboots.

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
