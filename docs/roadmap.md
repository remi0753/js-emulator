# Devices, Roadmap & Design Decisions

## Devices (added incrementally)

- **Console**: v1 writes to `process.stdout` via the `WRITE` syscall. The OS also
  accumulates everything in `os.output` for inspection/testing.
- **Timer**: v1 has no real timer — the quantum stands in for it (see
  [architecture.md](architecture.md)). v2 will add a real interrupt vector.
- **Keyboard**: v2 will add a blocking `READ` syscall.

## Roadmap

1. ✅ `src/cpu.ts` — memory + CPU + ISA table + `run`/`loadContext`/`saveContext`
2. ✅ `src/assembler.ts` — mnemonics -> bytecode (with label resolution)
3. ✅ unit tests — arithmetic, branching, `WRITE`, `HLT` for a single process
4. ✅ `src/os.ts` — PCB / round-robin scheduler / `handleSyscall` / loader
5. ✅ demo — two processes interleaving output (preemptive multitasking works)
6. ⬜ next: harden `SPAWN`/`SLEEP`, then v2 (MMU, real interrupts, shell/FS)

## Design decisions

- Register machine (R0–R7 + PC/SP/FLAGS), 32-bit, little-endian.
- Variable-length instructions; one ISA table shared by CPU and assembler.
- **The CPU's `run(maxCycles)` always returns to JS** — so the OS does time
  slicing in plain JS. Timer interrupt = quantum expiry. Syscall = `INT 0x80`.
- v1 isolates processes with a dedicated memory image each. MMU and real
  interrupts are deferred to v2.

## Toward v2

- **MMU**: single physical memory + `BASE`/`LIMIT` registers, address
  translation, and protection faults.
- **Real interrupts**: an IDT/IRET-style vector instead of quantum-as-timer.
- **Shell + filesystem**: a userland shell program plus a simple FS device.
