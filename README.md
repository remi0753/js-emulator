# js-emulator

A virtual 32-bit register-machine **CPU** and a guest operating system running
on it. The maintained v3+ kernel and userland execute inside the VM; TypeScript
provides the virtual hardware, toolchain, disk-image builder, and host bridge.

The whole thing rests on one idea, the **CPU/OS boundary**: the CPU's
`run(maxCycles)` always returns control to JavaScript after a fixed number of
instructions (or on a trap/fault/interrupt). That return stands in for a hardware
timer interrupt, letting the OS swap process state and implement preemption.

## Run the maintained guest OS

Build a persistent disk containing the compiled guest kernel, userland, boot
manifest, and filesystem, then boot that disk with its TTY attached to the host
terminal:

```bash
npm install
npm run build:img
npm run boot
```

`npm run boot -- path/to/image.img` boots a different image. Guest Ctrl-C,
Ctrl-D, and Ctrl-Z retain their terminal meanings. Press Ctrl-] to leave the VM
monitor. Filesystem changes are written back to the image on clean exit.

The boot tool bridges the guest NIC to the host's real UDP stack, so the host
and the guest can hold a `nc` conversation over UDP — see
[docs/udp-networking.md](docs/udp-networking.md).

## Earlier generations

### v1 — the smallest real preemptive OS · [docs/v1.md](docs/v1.md)

A 32-bit register machine plus a tiny JS round-robin OS. No MMU, no privilege
levels, no devices — just enough to make **preemptive multitasking** real and to
show the CPU/OS boundary on its own. Two processes time-slice and interleave:

```
A:A  B:B  A:A  B:B  A:A  B:B  A:A  B:B  A:A  B:B   # two processes, time-sliced
```

### v2 — a Unix-like OS (feature-complete) · [docs/v2.md](docs/v2.md)

The same trick scaled up into a realistic, **xv6-style** OS: genuine
**privilege separation**, a **paging MMU**, hardware **traps/interrupts**,
**port-mapped devices**, a **filesystem** on a host-backed disk, and a Unix
process model (`fork`/`exec`/`wait`/pipes, copy-on-write, blocking I/O) with a
**shell**. The hardware and the user/kernel boundary are real; only the kernel's
implementation language stays the host (TypeScript). **It boots to a shell and
`ls` lists the files on the mounted `disk.img`** — run `node demo/v2-shell.ts`
(interactive in a real terminal).

## Layout

```
src/isa.ts         ISA table — single source of truth shared by CPU & assembler
src/abi.ts         stable userspace/kernel syscall and file ABI
src/assembler.ts   assembly text -> bytecode (two-pass, label resolution)
src/formats/       shared executable and boot-block formats
src/storage/       generic block-device contract, filesystem, and VM port adapter
src/v1/            v1 — register machine + JS round-robin OS (working demo)
  cpu.ts           register machine: fetch-decode-execute, memory, interrupts
  os.ts            PCB, round-robin scheduler, syscalls, program loader
src/vm/custom32/   virtual hardware boundary: machine, cpu, memory, mmu, ports, devices
src/v2/            v2 — Unix-like OS (in progress)
  kernel/          pmm (refcounts), vmm (COW), scheduler, syscalls, process model (fork/exec/wait)
  userland/        guest programs: init, sh, coreutils (echo, cat, ls)
demo/multitask.ts  two v1 processes printing interleaved
demo/v2-preempt.ts user-mode preemptive multitasking (paging + traps)
demo/v2-fork-exec.ts  fork / exec / wait / exit — the Unix process model
demo/v2-fs.ts      block disk + on-disk filesystem, exec from disk, persistent disk.img
demo/v2-shell.ts   boot -> shell -> ls (the v2 acceptance target; interactive on a TTY)
demo/v2-pipe.ts    pipes + blocking I/O (producer | consumer)
src/v3/            maintained compiled guest kernel and userland
tools/mkimg.ts      build disk.img with the installed guest kernel + filesystem
tools/boot.ts       boot disk.img and attach the guest TTY to the host terminal
test/              node:test unit tests
```

## Requirements

Node.js v24+ (runs `.ts` directly via `--experimental-strip-types`; no build step).

## Setup

```bash
npm install        # type defs + tsc (running the code needs no build)
npm run demo       # run the multitasking demo
npm test           # unit tests
npm run typecheck  # tsc type check
```

## Docs

- [docs/v1.md](docs/v1.md) — v1 in detail: the CPU/OS boundary, scheduler, isolation
- [docs/v2.md](docs/v2.md) — v2 design: privilege, paging MMU, traps, port I/O,
  filesystem, shell
- [docs/ja-implementation-and-vision.md](docs/ja-implementation-and-vision.md) —
  Japanese deep-dive: current implementation, Linux differences, and the
  Linux-like guest OS roadmap
- [docs/isa.md](docs/isa.md) — registers, encoding, instruction set (shared core)
- [docs/syscalls.md](docs/syscalls.md) — system call ABI
- [docs/udp-networking.md](docs/udp-networking.md) — host ↔ guest UDP chat: the
  NIC bridge, the virtual network, and the guest `nc`
- [docs/roadmap.md](docs/roadmap.md) — devices, roadmap (v1 → v2 → v3), design decisions
