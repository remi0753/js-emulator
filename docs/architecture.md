# Architecture

```
┌────────────────────────────────────────┐
│ User programs (bytecode)                 │  produced by the assembler
├────────────────────────────────────────┤
│ OS layer (TypeScript)                    │  PCB / scheduler / syscall / loader
├────────────────────────────────────────┤
│ Virtual CPU (TypeScript)                 │  fetch-decode-execute / memory / int
└────────────────────────────────────────┘
```

## The CPU/OS boundary (the core idea)

The CPU exposes:

```ts
cpu.run(maxCycles): RunResult
```

It executes up to `maxCycles` instructions, then returns to JS immediately when
any of these happen:

| `reason`    | trigger                                   | OS response                          |
|-------------|-------------------------------------------|--------------------------------------|
| `'quantum'` | `maxCycles` reached                       | save state, next process (preempt)   |
| `'int'`     | `INT n` executed (`result.int = n`)       | handle syscall, maybe reschedule     |
| `'halt'`    | `HLT` executed                            | terminate the process                |
| `'fault'`   | bad opcode / div-by-zero / out-of-range   | kill the process                     |

Because control returns every `QUANTUM` instructions, the OS gets the same
opportunity a timer interrupt would give it — without any real interrupt
hardware. This is what makes preemption possible.

## Context and the PCB

A process's execution state is a `Context`:

```ts
{ regs: number[8], pc, sp, flags, mem /* v1: a dedicated memory image */ }
```

The OS keeps it inside a **PCB (Process Control Block)** and cycles through:

```ts
cpu.loadContext(pcb.ctx)   // install registers + memory
const r = cpu.run(QUANTUM) // run a time slice
cpu.saveContext(pcb.ctx)   // copy scalar state back (mem/regs are shared refs)
```

## Scheduler loop (round-robin)

```
while (readyQueue not empty OR sleepers exist) {
  if readyQueue empty: advance clock to wake the next sleeper; continue
  pcb = readyQueue.shift()
  load -> run(QUANTUM) -> save
  clock++ ; wake sleepers whose wakeAt <= clock
  switch (reason) {
    quantum: push pcb to tail (preempted)
    int:     handleSyscall(pcb)         // requeues unless it blocks/exits
    halt:    terminate(pcb, 0)
    fault:   terminate(pcb, -1)
  }
}
```

Per the spec, a non-blocking syscall also pushes the process to the queue tail,
so syscalls act as natural reschedule points in addition to quantum expiry.

## Process isolation

**v1**: each process owns an independent `Uint8Array` memory image. A context
switch swaps both the registers and the memory reference, giving full isolation
with no MMU.

**v2 (future)**: a single physical memory plus `BASE`/`LIMIT` registers for
address translation and protection faults — closer to a real MMU.

## Time and sleeping

There is no real timer. The OS keeps a `clock` counter that ticks once per
executed quantum. `SLEEP n` blocks a process until `clock >= wakeAt`. When only
sleepers remain, the scheduler fast-forwards `clock` to the earliest wake time so
the system never deadlocks on idle.
