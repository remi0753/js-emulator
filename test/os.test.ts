import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OS } from '../src/os.ts';

// An OS that just collects console output into an array.
function makeOS(quantum = 1000) {
  const events: string[] = [];
  const os = new OS({ quantum, onWrite: (c) => events.push(c), log: () => {} });
  return { os, events };
}

test('preemption: CPU-bound processes make progress in turns via the quantum', () => {
  // Each process repeats "heavy compute (NOP loop) -> print one char".
  // Without forced preemption at the small quantum, one process would hog
  // the CPU since these never make a syscall in the inner loop.
  const heavyPrinter = (ch: string) => `
      MOV R7, 0
      MOV R6, 1
      MOV R5, 3          ; print 3 times
    outer:
      CMP R5, R7
      JZ  done
      MOV R4, 200        ; inner loop count (burns time)
    inner:
      DEC R4
      CMP R4, R7
      JNZ inner
      MOV R0, 1          ; WRITE
      MOV R1, '${ch}'
      INT 0x80
      SUB R5, R6
      JMP outer
    done:
      MOV R0, 0          ; EXIT
      MOV R1, 0
      INT 0x80
  `;

  const { os, events } = makeOS(50); // force preemption every 50 instructions
  os.spawn(os.loadProgram('A', heavyPrinter('A')));
  os.spawn(os.loadProgram('B', heavyPrinter('B')));
  os.run();

  const out = events.join('');
  assert.equal(out.length, 6, '3 chars from each process, 6 total');
  // both made progress (neither hogged the CPU)
  assert.equal([...out].filter((c) => c === 'A').length, 3);
  assert.equal([...out].filter((c) => c === 'B').length, 3);
  // at least one A/B adjacency proves interleaving
  assert.ok(/AB|BA/.test(out), `expected interleaving: ${out}`);
});

test('EXIT: the exit code is recorded in the PCB', () => {
  const { os } = makeOS();
  os.spawn(
    os.loadProgram(
      'exit42',
      `
      MOV R0, 0
      MOV R1, 42
      INT 0x80
    `,
    ),
  );
  os.run();
  const pcb = os.processes.get(1)!;
  assert.equal(pcb.state, 'terminated');
  assert.equal(pcb.exitCode, 42);
});

test('GETPID: R0 receives the caller PID', () => {
  const { os, events } = makeOS();
  // GETPID, then write the PID as a char code.
  os.spawn(
    os.loadProgram(
      'pid',
      `
      MOV R0, 3          ; GETPID
      INT 0x80           ; R0 = pid (=1)
      MOVR R1, R0        ; keep it for printing
      MOV R0, 1          ; WRITE
      INT 0x80
      MOV R0, 0          ; EXIT
      INT 0x80
    `,
    ),
  );
  os.run();
  assert.equal(events.join('').charCodeAt(0), 1); // pid 1
});

test('SPAWN: a parent spawns a child and both print', () => {
  const { os, events } = makeOS();
  const child = os.loadProgram(
    'child',
    `
      MOV R0, 1
      MOV R1, 'C'
      INT 0x80
      MOV R0, 0
      INT 0x80
  `,
  );
  const parent = os.loadProgram(
    'parent',
    `
      MOV R0, 4          ; SPAWN
      MOV R1, ${child}   ; program ID
      INT 0x80           ; R0 = child PID
      MOV R0, 1          ; WRITE
      MOV R1, 'P'
      INT 0x80
      MOV R0, 0          ; EXIT
      INT 0x80
  `,
  );
  os.spawn(parent);
  os.run();
  const out = events.join('');
  assert.ok(out.includes('P'), 'parent printed');
  assert.ok(out.includes('C'), 'child printed');
  assert.equal(os.processes.size, 2, 'parent + child = 2 processes');
});

test('SLEEP: other processes run while one sleeps', () => {
  const { os, events } = makeOS();
  // sleeper: print -> sleep a while -> print. busy: prints several times in between.
  os.spawn(
    os.loadProgram(
      'sleeper',
      `
      MOV R0, 1
      MOV R1, 'S'
      INT 0x80
      MOV R0, 5          ; SLEEP
      MOV R1, 100        ; 100 ticks
      INT 0x80
      MOV R0, 1
      MOV R1, 'S'
      INT 0x80
      MOV R0, 0
      INT 0x80
  `,
    ),
  );
  os.spawn(
    os.loadProgram(
      'busy',
      `
      MOV R7, 0
      MOV R6, 1
      MOV R5, 3
    loop:
      CMP R5, R7
      JZ  done
      MOV R0, 1
      MOV R1, 'b'
      INT 0x80
      SUB R5, R6
      MOV R0, 2          ; YIELD
      INT 0x80
      JMP loop
    done:
      MOV R0, 0
      INT 0x80
  `,
    ),
  );
  os.run();
  const out = events.join('');
  // a 'b' should appear between the sleeper's two 'S' outputs.
  const first = out.indexOf('S');
  const last = out.lastIndexOf('S');
  assert.ok(last > first, 'S printed twice');
  assert.ok(out.slice(first + 1, last).includes('b'), `expected b while sleeping: ${out}`);
});
