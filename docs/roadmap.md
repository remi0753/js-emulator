# Devices, Roadmap & Design Decisions

## Devices (added incrementally)

- **Console**: v1 writes to `process.stdout` via the `WRITE` syscall. v2 makes it
  a port-mapped tty driven by a kernel driver.
- **Timer**: v1 has no real timer — the quantum stands in for it. v2 adds a
  programmable PIT that drives preemption and the clock.
- **Keyboard**: v2 adds an input ring buffer + IRQ and a blocking `read`.
- **Block disk**: v2 adds a 512-byte-sector disk backed by host `disk.img`,
  carrying the filesystem (persistent across runs).

## Roadmap

### v1 — register machine + cooperative-ish multitasking ✅

1. ✅ `src/cpu.ts` — memory + CPU + ISA table + `run`/`loadContext`/`saveContext`
2. ✅ `src/assembler.ts` — mnemonics -> bytecode (with label resolution)
3. ✅ unit tests — arithmetic, branching, `WRITE`, `HLT` for a single process
4. ✅ `src/os.ts` — PCB / round-robin scheduler / `handleSyscall` / loader
5. ✅ demo — two processes interleaving output (preemptive multitasking works)

### v2 — Unix-like OS (see [v2-architecture.md](v2-architecture.md))

Goal: xv6-style OS — paging MMU, real traps/interrupts, port I/O, a filesystem
on a host-backed disk, and a Unix process model with a shell.

**Acceptance target (definition of done for v2):** boot the kernel, reach an
interactive **shell**, and run **`ls`** to list the files and directories on the
mounted `disk.img`. Reaching this exercises every v2 layer end to end — paging,
traps/syscalls, the scheduler, the block driver, the filesystem/VFS, file
descriptors, `fork`/`exec`, and userland.

- **Phase 1** ✅ CPU privilege levels + paging MMU + trap/fault/IRQ model +
  `IN`/`OUT` port I/O (with tests for translation, page faults, privilege traps).
- **Phase 2** ⬜ TS kernel core on the virtual HW: physical & virtual memory
  managers, timer-driven preemptive scheduler, syscall dispatch, console driver;
  run a user-mode program that syscalls and gets preempted.
- **Phase 3** ⬜ process model: `fork`/`exec`/`wait`/`exit`, ELF-like loader,
  multiple user programs.
- **Phase 4** ⬜ storage: block driver over `disk.img`, on-disk FS, VFS, file
  descriptors, `open`/`read`/`write`/`close`, exec from the FS.
- **Phase 5** ⬜ userland: `init`, a shell, a few coreutils, pipes.
- **Phase 6** ⬜ polish: keyboard input, more syscalls, copy-on-write `fork`.

### v3 — self-hosting (model B): the kernel becomes guest code

Long-term ambition: move the kernel *off* the host and onto the VM, so the OS is
truly self-hosted. JS provides only the hardware (CPU, MMU, devices); the kernel
and all of userland are guest bytecode running on the virtual machine — the most
faithful model of a real OS.

Writing a whole kernel + userland in raw assembly is impractical, so this stage
is really about building a **toolchain** first, then porting.

- **Phase 7** ⬜ in-CPU trap machinery for guest kernels: real interrupt vector
  table (IDT) + kernel-mode execution + `IRET` + a kernel stack / trap frame on
  the CPU itself (model A handled traps in TS; model B needs them in-guest).
- **Phase 8** ⬜ a **C-like language and compiler** targeting the ISA: lexer,
  parser, type checker, codegen, plus a linker and a tiny freestanding runtime
  (`crt0`, no host libc). This is itself a large sub-project.
- **Phase 9** ⬜ port the kernel (memory managers, scheduler, VFS, drivers,
  fork/exec) from TypeScript to the C-like language; boot it in kernel mode.
- **Phase 10** ⬜ port userland (libc, shell, coreutils) and build a real disk
  image from compiled guest binaries; the TS layer shrinks to pure hardware.
- **Phase 11** ⬜ stretch: self-hosting toolchain (the compiler/assembler run
  *inside* the guest OS), so the system can rebuild itself.

## Design decisions

- Register machine (R0–R7 + PC/SP/FLAGS), 32-bit, little-endian.
- Variable-length instructions; one ISA table shared by CPU and assembler.
- **The CPU's `run(maxCycles)` always returns to JS** — so the kernel (TS) does
  time slicing and trap handling in the host. This is the v1 mechanism and also
  the v2 model-A mechanism.
- **Kernel in TS, hardware real (v2 model A)**: user programs are guest bytecode
  in user mode; privilege separation, paging, traps and port I/O are enforced by
  the virtual CPU. A self-hosted guest kernel (model B) would need a C->ISA
  compiler and is out of scope.
- **Paging MMU** (two-level, 4 KiB pages) for per-process virtual address spaces
  — chosen over BASE/LIMIT segmentation for realism.
- **Port-mapped I/O** (`IN`/`OUT`) for devices; **host-file-backed disk** for a
  persistent filesystem.
