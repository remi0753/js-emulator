import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import {
  type Executable,
  encodeExecutable,
  parseExecutable,
  SEG,
} from '../src/formats/executable.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';
import { LAYOUT } from '../src/v2/layout.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PTE } from '../src/vm/custom32/mmu.ts';

function bytes(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

// Assemble a user program at the address it will be loaded (so labels relocate).
function image(source: string): Uint8Array {
  return assemble(source, LAYOUT.USER_TEXT).bytes;
}

function makeKernel(quantum = 1000) {
  let out = '';
  const kernel = new Kernel({ quantum, consoleSink: (s) => (out += s), log: () => {} });
  return { kernel, getOut: () => out };
}

test('kernel can run on an injected custom32 machine', () => {
  let out = '';
  const machine = new Machine({ consoleSink: (s) => (out += s) });
  const kernel = new Kernel({ machine, log: () => {} });
  kernel.spawn(
    'hello',
    image(`
      MOV R0, 1
      MOV R1, 1
      MOV R2, msg
      MOV R3, 1
      INT 0x80
      MOV R0, 0
      INT 0x80
    msg:
      .string "M"
    `),
  );
  kernel.run();
  assert.equal(kernel.machine, machine);
  assert.equal(out, 'M');
});

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

// --- Phase 4: filesystem, file descriptors, exec from disk ---

test('open/write/close then open/read: a file round-trips through syscalls', () => {
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'io',
    image(`
      MOV R0, 7          ; OPEN "/data", O_RDWR|O_CREATE
      MOV R1, path
      MOV R2, 0x202
      INT 0x80
      MOVR R5, R0        ; fd
      MOV R0, 1          ; WRITE(fd, msg, 4)
      MOVR R1, R5
      MOV R2, msg
      MOV R3, 4
      INT 0x80
      MOV R0, 8          ; CLOSE(fd)
      MOVR R1, R5
      INT 0x80
      MOV R0, 7          ; OPEN "/data", O_RDONLY
      MOV R1, path
      MOV R2, 0
      INT 0x80
      MOVR R5, R0
      MOV R0, 9          ; READ(fd, buf, 16)
      MOVR R1, R5
      MOV R2, buf
      MOV R3, 16
      INT 0x80
      MOVR R6, R0        ; nread
      MOV R0, 1          ; WRITE(stdout, buf, nread)
      MOV R1, 1
      MOV R2, buf
      MOVR R3, R6
      INT 0x80
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    path:
      .string "/data"
    msg:
      .string "DISK"
    buf:
      .word 0
      .word 0
      .word 0
      .word 0
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'DISK');
  // The file persists in the filesystem after the writer exits.
  assert.equal(kernel.processes.get(1)!.exitCode, 0);
});

test('open on a missing file without O_CREATE returns -1', () => {
  const { kernel } = makeKernel();
  kernel.spawn(
    'p',
    image(`
      MOV R0, 7          ; OPEN "/nope", O_RDONLY
      MOV R1, path
      MOV R2, 0
      INT 0x80
      MOVR R1, R0        ; exit with the open() result (-1)
      MOV R0, 0
      INT 0x80
    path:
      .string "/nope"
    `),
  );
  kernel.run();
  assert.equal(kernel.processes.get(1)!.exitCode, -1);
});

test('a directory is an openable, readable file (dirents)', () => {
  // Open "/", read the first 16-byte dirent, and print the first char of its
  // name. The first entry is ".", so the program prints ".".
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'ls0',
    image(`
      MOV R0, 7          ; OPEN "/", O_RDONLY
      MOV R1, root
      MOV R2, 0
      INT 0x80
      MOVR R5, R0
      MOV R0, 9          ; READ one dirent (16 bytes)
      MOVR R1, R5
      MOV R2, ent
      MOV R3, 16
      INT 0x80
      MOV R2, ent        ; name starts 2 bytes in (after the u16 inum)
      MOV R4, 2
      ADD R2, R4
      MOV R0, 1          ; WRITE(stdout, &name, 1)
      MOV R1, 1
      MOV R3, 1
      INT 0x80
      MOV R0, 0
      MOV R1, 0
      INT 0x80
    root:
      .string "/"
    ent:
      .word 0
      .word 0
      .word 0
      .word 0
    `),
  );
  kernel.run();
  assert.equal(getOut(), '.');
});

test('spawnFromFile boots an executable read from the filesystem', () => {
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
  kernel.spawnFromFile('init', '/bin/hi');
  kernel.run();
  assert.equal(getOut(), 'HI');
  assert.equal(kernel.processes.get(1)!.name, 'init');
});

test('the filesystem persists across a remount from the disk image', () => {
  const k1 = new Kernel({ log: () => {} });
  k1.fs.writeFile('/greeting', bytes('persisted!'));

  // Re-create a kernel mounting the very same disk bytes.
  const k2 = new Kernel({ diskImage: k1.disk.data, log: () => {} });
  const inum = k2.fs.namei('/greeting');
  assert.notEqual(inum, 0);
  assert.equal(String.fromCharCode(...k2.fs.readFile(inum)), 'persisted!');
});

// --- Phase 6: copy-on-write fork (at the vmm level) ---

test('fork is copy-on-write: frames are shared until written, then copied', () => {
  const k = new Kernel({ log: () => {} });
  const V = 0x4000;
  const pd = k.vmm.createAddressSpace();
  const frame = k.vmm.mapPage(pd, V, PTE.U | PTE.W);
  k.phys.bytes[frame] = 1; // the parent's data byte

  const before = k.pmm.freeCount;
  const child = k.vmm.cowCloneAddressSpace(pd);
  // The child gets its own page directory + page table, but the data frame is
  // *shared* (not copied): only 2 frames consumed.
  assert.equal(before - k.pmm.freeCount, 2);

  // Writing into the child triggers the copy: exactly one more frame.
  k.vmm.copyout(child, V, new Uint8Array([2]));
  assert.equal(before - k.pmm.freeCount, 3);

  // The two address spaces are now isolated.
  const p = k.cpu.mmu.translate(pd, V, { write: false, user: true });
  const c = k.cpu.mmu.translate(child, V, { write: false, user: true });
  assert.ok(p.ok && c.ok);
  assert.equal(k.phys.bytes[p.paddr], 1);
  assert.equal(k.phys.bytes[c.paddr], 2);

  // No leak: tearing both down returns every frame.
  k.vmm.freeAddressSpace(child);
  k.vmm.freeAddressSpace(pd);
  assert.equal(k.pmm.freeCount, k.pmm.total);
});

// --- Phase 6: pipes, dup, blocking keyboard input, uptime ---

test('pipe: a child writes, the parent reads through the pipe', () => {
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'pipe',
    image(`
      MOV R0, 10         ; PIPE(fds)
      MOV R1, fds0
      INT 0x80
      MOV R0, 4          ; FORK
      INT 0x80
      MOV R7, 0
      CMP R0, R7
      JZ  child
    parent:
      LOAD R1, fds1      ; close our copy of the write end
      MOV  R0, 8
      INT  0x80
    p_read:
      LOAD R1, fds0      ; READ(readfd, buf, 8)
      MOV  R0, 9
      MOV  R2, buf
      MOV  R3, 8
      INT  0x80
      CMP  R0, R7
      JZ   p_done        ; EOF
      MOVR R3, R0
      MOV  R0, 1         ; WRITE(stdout, buf, n)
      MOV  R1, 1
      MOV  R2, buf
      INT  0x80
      JMP  p_read
    p_done:
      MOV  R0, 0
      MOV  R1, 0
      INT  0x80
    child:
      LOAD R1, fds1      ; WRITE(writefd, "hi", 2)
      MOV  R0, 1
      MOV  R2, msg
      MOV  R3, 2
      INT  0x80
      LOAD R1, fds1      ; close the write end -> reader sees EOF
      MOV  R0, 8
      INT  0x80
      MOV  R0, 0
      MOV  R1, 0
      INT  0x80
    fds0:
      .word 0
    fds1:
      .word 0
    buf:
      .word 0,0
    msg:
      .string "hi"
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'hi');
});

test('dup: a duplicated fd writes to the same console', () => {
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'dup',
    image(`
      MOV  R0, 11        ; DUP(1)
      MOV  R1, 1
      INT  0x80
      MOVR R5, R0        ; new fd
      MOV  R0, 1         ; WRITE(newfd, "OK", 2)
      MOVR R1, R5
      MOV  R2, msg
      MOV  R3, 2
      INT  0x80
      MOV  R0, 0
      MOV  R1, 0
      INT  0x80
    msg:
      .string "OK"
    `),
  );
  kernel.run();
  assert.equal(getOut(), 'OK');
});

test('uptime: returns a nonzero tick count', () => {
  const { kernel } = makeKernel();
  kernel.spawn(
    'up',
    image(`
      MOV  R0, 12        ; UPTIME
      INT  0x80
      MOVR R1, R0        ; exit with the tick count
      MOV  R0, 0
      INT  0x80
    `),
  );
  kernel.run();
  assert.ok(kernel.processes.get(1)!.exitCode! >= 1);
});

test('read blocks until keyboard input arrives, then resumes', () => {
  const { kernel, getOut } = makeKernel();
  kernel.spawn(
    'getc',
    image(`
      MOV  R0, 9         ; READ(stdin, buf, 1) -> blocks (no input yet)
      MOV  R1, 0
      MOV  R2, buf
      MOV  R3, 1
      INT  0x80
      MOVR R3, R0
      MOV  R0, 1         ; echo the byte
      MOV  R1, 1
      MOV  R2, buf
      INT  0x80
      MOV  R0, 0
      MOV  R1, 0
      INT  0x80
    buf:
      .word 0
    `),
  );
  kernel.run(); // the process blocks reading stdin
  assert.equal(getOut(), '');
  assert.ok(kernel.waitingForInput);
  assert.equal(kernel.processes.get(1)!.state, 'blocked');

  kernel.feedInput('X'); // a "keypress" wakes the reader
  kernel.run();
  assert.equal(getOut(), 'X');
  assert.equal(kernel.processes.get(1)!.state, 'zombie');
});
