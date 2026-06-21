# js-emulator

A virtual 32-bit register-machine **CPU** and a **preemptive multitasking OS**
running on top of it, both written in TypeScript.

The whole point is the **CPU/OS boundary**: the CPU's `run(maxCycles)` always
returns control to JavaScript after a fixed number of instructions. That return
stands in for a hardware timer interrupt, letting the OS (plain JS) swap process
state and implement preemption.

```
A:A  B:B  A:A  B:B  A:A  B:B  A:A  B:B  A:A  B:B   # two processes, time-sliced
```

## Layout

```
src/isa.ts         ISA table — single source of truth shared by CPU & assembler
src/assembler.ts   assembly text -> bytecode (two-pass, label resolution)
src/v1/            v1 — register machine + JS round-robin OS (working demo)
  cpu.ts           register machine: fetch-decode-execute, memory, interrupts
  os.ts            PCB, round-robin scheduler, syscalls, program loader
src/v2/            v2 — Unix-like OS (in progress)
  hw/              virtual hardware: cpu (privilege/MMU/traps), memory, mmu, ports
demo/multitask.ts  two v1 processes printing interleaved
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

- [docs/architecture.md](docs/architecture.md) — v1 layers and the CPU/OS boundary
- [docs/v2-architecture.md](docs/v2-architecture.md) — v2 design: Unix-like OS
  (paging MMU, traps, port I/O, filesystem, shell)
- [docs/isa.md](docs/isa.md) — registers, encoding, instruction set
- [docs/syscalls.md](docs/syscalls.md) — system call ABI
- [docs/roadmap.md](docs/roadmap.md) — devices, roadmap, design decisions
