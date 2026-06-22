# js-emulator

A virtual 32-bit register-machine **CPU** and an **operating system** running on
top of it, both written in TypeScript — built up in two generations.

The whole thing rests on one idea, the **CPU/OS boundary**: the CPU's
`run(maxCycles)` always returns control to JavaScript after a fixed number of
instructions (or on a trap/fault/interrupt). That return stands in for a hardware
timer interrupt, letting the OS swap process state and implement preemption.

## Two generations

### v1 — the smallest real preemptive OS · [docs/v1.md](docs/v1.md)

A 32-bit register machine plus a tiny JS round-robin OS. No MMU, no privilege
levels, no devices — just enough to make **preemptive multitasking** real and to
show the CPU/OS boundary on its own. Two processes time-slice and interleave:

```
A:A  B:B  A:A  B:B  A:A  B:B  A:A  B:B  A:A  B:B   # two processes, time-sliced
```

### v2 — a Unix-like OS (in progress) · [docs/v2.md](docs/v2.md)

The same trick scaled up into a realistic, **xv6-style** OS: genuine
**privilege separation**, a **paging MMU**, hardware **traps/interrupts**,
**port-mapped devices**, a **filesystem** on a host-backed disk, and a Unix
process model (`fork`/`exec`/`wait`/pipes) with a **shell**. The hardware and the
user/kernel boundary are real; only the kernel's implementation language stays
the host (TypeScript). **Done when** the kernel boots to a shell and `ls` lists
the files on the mounted `disk.img`.

## Layout

```
src/isa.ts         ISA table — single source of truth shared by CPU & assembler
src/assembler.ts   assembly text -> bytecode (two-pass, label resolution)
src/v1/            v1 — register machine + JS round-robin OS (working demo)
  cpu.ts           register machine: fetch-decode-execute, memory, interrupts
  os.ts            PCB, round-robin scheduler, syscalls, program loader
src/v2/            v2 — Unix-like OS (in progress)
  hw/              virtual hardware: cpu (privilege/MMU/traps), memory, mmu, ports, devices (console, disk)
  kernel/          pmm, vmm, scheduler, syscalls, process model (fork/exec/wait), exec format, block driver, filesystem
demo/multitask.ts  two v1 processes printing interleaved
demo/v2-preempt.ts user-mode preemptive multitasking (paging + traps)
demo/v2-fork-exec.ts  fork / exec / wait / exit — the Unix process model
demo/v2-fs.ts      block disk + on-disk filesystem, exec from disk, persistent disk.img
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
- [docs/isa.md](docs/isa.md) — registers, encoding, instruction set (shared core)
- [docs/syscalls.md](docs/syscalls.md) — system call ABI
- [docs/roadmap.md](docs/roadmap.md) — devices, roadmap (v1 → v2 → v3), design decisions
