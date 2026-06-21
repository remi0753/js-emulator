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
src/isa.ts        ISA table — single source of truth shared by CPU & assembler
src/cpu.ts        register machine: fetch-decode-execute, memory, interrupts
src/assembler.ts  assembly text -> bytecode (two-pass, label resolution)
src/os.ts         PCB, round-robin scheduler, syscalls, program loader
demo/multitask.ts two processes printing interleaved
test/             node:test unit tests
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

- [docs/architecture.md](docs/architecture.md) — layers and the CPU/OS boundary
- [docs/isa.md](docs/isa.md) — registers, encoding, instruction set
- [docs/syscalls.md](docs/syscalls.md) — system call ABI
- [docs/roadmap.md](docs/roadmap.md) — devices, roadmap, design decisions
