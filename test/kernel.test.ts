import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import { LAYOUT } from '../src/v2/kernel/abi.ts';
import { type Executable, encodeExecutable, parseExecutable, SEG } from '../src/v2/kernel/exec.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';

// Assemble a user program at the address it will be loaded (so labels relocate).
function image(source: string): Uint8Array {
  return assemble(source, LAYOUT.USER_TEXT).bytes;
}

function makeKernel(quantum = 1000) {
  let out = '';
  const kernel = new Kernel({ quantum, consoleSink: (s) => (out += s), log: () => {} });
  return { kernel, getOut: () => out };
}

test('a user-mode program writes via syscall and exits', () => {
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'hello',
    image(`
      MOV R0, 1        ; SYS_WRITE
      MOV R1, 1        ; fd = stdout
      MOV R2, msg      ; buf (relocated to its runtime vaddr)
      MOV R3, 5        ; len
      INT 0x80
      MOV R0, 0        ; SYS_EXIT
      MOV R1, 0
      INT 0x80
    msg:
      .string "HELLO"
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'HELLO');
  assert.equal(kernel.processes.get(1)!.exitCode, 0);
  assert.equal(kernel.processes.get(1)!.state, 'zombie');
});

test('GETPID returns the pid; EXIT records the code', () => {
  const { kernel } = makeKernel();
  kernel.spawn(
    'p',
    image(`
      MOV R0, 3        ; GETPID
      INT 0x80         ; R0 = pid
      MOVR R1, R0      ; exit code = pid
      MOV R0, 0        ; EXIT
      INT 0x80
    `),
  );
  kernel.run();
  assert.equal(kernel.processes.get(1)!.exitCode, 1);
});

test('bad pointer to write() returns -1, process survives', () => {
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'badptr',
    image(`
      MOV R0, 1            ; WRITE
      MOV R1, 1            ; fd
      MOV R2, 0x40000000   ; unmapped buf
      MOV R3, 4
      INT 0x80             ; R0 = -1 (BadAddress), but process keeps running
      MOV R0, 1            ; WRITE a valid byte to prove we survived
      MOV R2, ok
      MOV R3, 1
      INT 0x80
      MOV R0, 0            ; EXIT
      MOV R1, 0
      INT 0x80
    ok:
      .string "Z"
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'Z');
  assert.equal(kernel.processes.get(1)!.exitCode, 0);
});

test('an out-of-bounds access faults and the kernel kills the process', () => {
  const { kernel } = makeKernel();
  kernel.spawn(
    'crash',
    image(`
      LOAD R0, 0x40000000   ; page fault: unmapped
      MOV R0, 0
      INT 0x80
    `),
  );
  kernel.run();
  const p = kernel.processes.get(1)!;
  assert.equal(p.state, 'zombie');
  assert.equal(p.exitCode, -1);
});

test('timer preemption interleaves two CPU-bound processes', () => {
  const { kernel, getOut } = makeKernel(30); // tiny quantum forces preemption
  const printer = (ch: string) => `
      MOV R7, 0
      MOV R6, 1
      MOV R5, 3          ; print 3 times
    outer:
      CMP R5, R7
      JZ  done
      MOV R4, 50         ; burn time so the quantum expires mid-compute
    inner:
      DEC R4
      CMP R4, R7
      JNZ inner
      MOV R0, 1          ; WRITE
      MOV R1, 1          ; fd
      MOV R2, ch
      MOV R3, 1
      INT 0x80
      SUB R5, R6
      JMP outer
    done:
      MOV R0, 0          ; EXIT
      MOV R1, 0
      INT 0x80
    ch:
      .string "${ch}"
  `;
  kernel.spawn('A', image(printer('A')));
  kernel.spawn('B', image(printer('B')));
  kernel.run();

  const out = getOut();
  assert.equal(out.length, 6);
  assert.equal([...out].filter((c) => c === 'A').length, 3);
  assert.equal([...out].filter((c) => c === 'B').length, 3);
  assert.ok(/AB|BA/.test(out), `expected interleaving: ${out}`);
});

test('processes are isolated: same vaddr, independent memory', () => {
  // Each writes a distinct byte to the same user vaddr, then reads it back and
  // prints it. If address spaces were shared they would clobber each other.
  const prog = (ch: string) => `
      MOV R1, '${ch}'
      STORE R1, scratch    ; mem[scratch] = ch
      MOV R0, 2            ; YIELD (let the other run between store and load)
      INT 0x80
      LOAD R1, scratch     ; read it back
      STORE R1, buf
      MOV R0, 1            ; WRITE buf
      MOV R1, 1
      MOV R2, buf
      MOV R3, 1
      INT 0x80
      MOV R0, 0
      INT 0x80
    scratch:
      .word 0
    buf:
      .word 0
  `;
  const { kernel, getOut } = makeKernel(1000);
  kernel.spawn('X', image(prog('X')));
  kernel.spawn('Y', image(prog('Y')));
  kernel.run();
  const out = getOut();
  // Both see their own value despite using the same virtual address.
  assert.ok(out.includes('X') && out.includes('Y'), `isolation broken: ${out}`);
});

// --- Phase 3: process model (fork / exec / wait / exit) ---

test('fork: parent gets the child pid, child gets 0; parent waits for the child', () => {
  // Child writes 'C' and exits; parent waits, then writes 'P'. With wait() the
  // parent blocks until the child is done, so the order is deterministic: "CP".
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'p',
    image(`
      MOV R0, 4          ; FORK
      INT 0x80
      MOV R7, 0
      CMP R0, R7
      JZ  child          ; R0 == 0 -> child
    parent:
      MOV R0, 6          ; WAIT (block for the child)
      MOV R1, 0          ; status ptr = ignore
      INT 0x80
      MOV R0, 1          ; WRITE 'P'
      MOV R1, 1
      MOV R2, pmsg
      MOV R3, 1
      INT 0x80
      MOV R0, 0          ; EXIT 0
      MOV R1, 0
      INT 0x80
    child:
      MOV R0, 1          ; WRITE 'C'
      MOV R1, 1
      MOV R2, cmsg
      MOV R3, 1
      INT 0x80
      MOV R0, 0          ; EXIT 7
      MOV R1, 7
      INT 0x80
    pmsg:
      .string "P"
    cmsg:
      .string "C"
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'CP');
});

test('wait: returns the reaped child pid and its exit status', () => {
  // Child exits with code 90 ('Z'). Parent waits with a status pointer, then
  // writes the reaped pid byte followed by the status byte.
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'p',
    image(`
      MOV R0, 4          ; FORK
      INT 0x80
      MOV R7, 0
      CMP R0, R7
      JZ  child
    parent:
      MOV R0, 6          ; WAIT
      MOV R1, status     ; status ptr
      INT 0x80
      STORE R0, pidbuf   ; save reaped pid
      MOV R0, 1          ; WRITE pid byte
      MOV R1, 1
      MOV R2, pidbuf
      MOV R3, 1
      INT 0x80
      MOV R0, 1          ; WRITE status byte
      MOV R1, 1
      MOV R2, status
      MOV R3, 1
      INT 0x80
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    child:
      MOV R0, 0          ; EXIT 90
      MOV R1, 90
      INT 0x80
    status:
      .word 0
    pidbuf:
      .word 0
    `),
  );
  kernel.run();
  const out = getOut();
  assert.equal(out.length, 2);
  assert.equal(out.charCodeAt(0), 2); // child pid (second process)
  assert.equal(out.charCodeAt(1), 90); // exit status low byte
});

test('fork: the child gets an independent copy of memory', () => {
  // Pre-fork the parent stores 'A'. The child prints its inherited copy then
  // overwrites it; the parent (after wait) prints its own copy, still 'A'. -> "AA"
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'p',
    image(`
      MOV R1, 'A'
      STORE R1, val
      MOV R0, 4          ; FORK
      INT 0x80
      MOV R7, 0
      CMP R0, R7
      JZ  child
    parent:
      MOV R0, 6          ; WAIT
      MOV R1, 0
      INT 0x80
      MOV R0, 1          ; WRITE parent's val (must still be 'A')
      MOV R1, 1
      MOV R2, val
      MOV R3, 1
      INT 0x80
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    child:
      MOV R0, 1          ; WRITE inherited val ('A')
      MOV R1, 1
      MOV R2, val
      MOV R3, 1
      INT 0x80
      MOV R1, 'C'        ; clobber the child's own copy
      STORE R1, val
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    val:
      .string "A"
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'AA');
});

test('exec: replaces the process image with an installed program', () => {
  const { kernel, getOut } = makeKernel();
  kernel.install(
    '/bin/hi',
    image(`
      MOV R0, 1
      MOV R1, 1
      MOV R2, msg
      MOV R3, 2
      INT 0x80
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    msg:
      .string "HI"
    `),
  );
  kernel.spawn(
    'loader',
    image(`
      MOV R0, 5          ; EXEC "/bin/hi"
      MOV R1, path
      INT 0x80
      MOV R0, 0          ; only reached if exec failed
      MOV R1, 1
      INT 0x80
    path:
      .string "/bin/hi"
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'HI');
  // The loader's pid was reused for the new image; it exits 0 from /bin/hi.
  assert.equal(kernel.processes.get(1)!.exitCode, 0);
  assert.equal(kernel.processes.get(1)!.name, '/bin/hi');
});

test('exec: a missing program returns -1 and the caller survives', () => {
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'p',
    image(`
      MOV R0, 5          ; EXEC "/nope" (not installed)
      MOV R1, path
      INT 0x80           ; R0 = -1, image unchanged
      MOV R0, 1          ; prove we're alive: WRITE 'E'
      MOV R1, 1
      MOV R2, ok
      MOV R3, 1
      INT 0x80
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    path:
      .string "/nope"
    ok:
      .string "E"
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'E');
  assert.equal(kernel.processes.get(1)!.exitCode, 0);
});

test('wait: with no children returns -1', () => {
  const { kernel } = makeKernel();
  kernel.spawn(
    'p',
    image(`
      MOV R0, 6          ; WAIT (no children)
      MOV R1, 0
      INT 0x80
      MOVR R1, R0        ; exit with the wait() return value
      MOV R0, 0
      INT 0x80
    `),
  );
  kernel.run();
  assert.equal(kernel.processes.get(1)!.exitCode, -1);
});

test('exit frees the address space: no physical frames leak', () => {
  const { kernel } = makeKernel();
  const total = kernel.pmm.total;
  kernel.install(
    '/bin/hi',
    image(`
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    `),
  );
  kernel.spawn(
    'p',
    image(`
      MOV R0, 4          ; FORK
      INT 0x80
      MOV R7, 0
      CMP R0, R7
      JZ  child
      MOV R0, 6          ; parent: WAIT then EXIT
      MOV R1, 0
      INT 0x80
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    child:
      MOV R0, 5          ; child: EXEC then exit via the new image
      MOV R1, path
      INT 0x80
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    path:
      .string "/bin/hi"
    `),
  );
  kernel.run();
  // Every process has exited; reaped children are gone and all frames returned.
  assert.equal(kernel.pmm.freeCount, total);
});

test('a BSS segment is mapped and zero-filled by the loader', () => {
  // Build an executable whose memSize exceeds its file bytes; the `bss` label
  // sits in that zero-filled region. The program reads it and prints 'B' if zero.
  const img = assemble(
    `
      LOAD R1, bss       ; read a word from BSS
      MOV R7, 0
      CMP R1, R7
      JNZ nonzero
      MOV R2, yes
      JMP emit
    nonzero:
      MOV R2, no
    emit:
      MOV R0, 1
      MOV R1, 1
      MOV R3, 1
      INT 0x80
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    yes:
      .string "B"
    no:
      .string "x"
    bss:
    `,
    LAYOUT.USER_TEXT,
  ).bytes;
  const exe: Executable = {
    entry: LAYOUT.USER_TEXT,
    segments: [
      {
        vaddr: LAYOUT.USER_TEXT,
        data: img,
        memSize: img.length + 16,
        flags: SEG.R | SEG.W | SEG.X,
      },
    ],
  };
  const { kernel, getOut } = makeKernel();
  kernel.spawn('bss', exe);
  kernel.run();
  assert.equal(getOut(), 'B');
});

test('executable format: encode/parse round-trips', () => {
  const exe: Executable = {
    entry: 0x2000,
    segments: [
      { vaddr: 0x1000, data: new Uint8Array([1, 2, 3]), memSize: 0x1000, flags: SEG.R | SEG.X },
      { vaddr: 0x4000, data: new Uint8Array([9]), memSize: 8, flags: SEG.R | SEG.W },
    ],
  };
  const back = parseExecutable(encodeExecutable(exe));
  assert.equal(back.entry, 0x2000);
  assert.equal(back.segments.length, 2);
  assert.deepEqual([...back.segments[0]!.data], [1, 2, 3]);
  assert.equal(back.segments[0]!.memSize, 0x1000);
  assert.equal(back.segments[1]!.flags, SEG.R | SEG.W);
});
