import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assemble } from '../src/assembler.ts';
import { LAYOUT } from '../src/v2/kernel/abi.ts';
import { Kernel } from '../src/v2/kernel/kernel.ts';
import { installUserland } from '../src/v2/userland/programs.ts';

function bytes(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

function makeKernel() {
  let out = '';
  const kernel = new Kernel({ consoleSink: (s) => (out += s), log: () => {} });
  return { kernel, getOut: () => out };
}

test('exec delivers argv: a program reads argc and argv[i]', () => {
  // Print argv[1] then exit with argc. Uses LB and the argv vector in R1.
  const prog = `
      MOVR R6, R1          ; argv
      MOVR R5, R0          ; argc
      MOVR R2, R6
      MOV  R1, 4
      ADD  R2, R1          ; &argv[1]
      LOADR R3, R2         ; argv[1]
    p:
      LB   R0, R3
      MOV  R4, 0
      CMP  R0, R4
      JZ   done
      PUSH R3
      MOV  R0, 1
      MOV  R1, 1
      MOVR R2, R3
      MOV  R3, 1
      INT  0x80
      POP  R3
      INC  R3
      JMP  p
    done:
      MOV  R0, 0
      MOVR R1, R5          ; exit code = argc
      INT  0x80
  `;
  const { kernel, getOut } = makeKernel();
  kernel.install('/bin/argtest', assemble(prog, LAYOUT.USER_TEXT).bytes);
  kernel.spawnFromFile('argtest', '/bin/argtest', ['argtest', 'HELLO']);
  kernel.run();
  assert.equal(getOut(), 'HELLO');
  assert.equal(kernel.processes.get(1)!.exitCode, 2); // argc
});

test('echo prints its arguments separated by spaces', () => {
  const { kernel, getOut } = makeKernel();
  installUserland(kernel);
  kernel.spawnFromFile('echo', '/bin/echo', ['echo', 'hello', 'world']);
  kernel.run();
  assert.equal(getOut(), 'hello world\n');
});

test('cat copies a file to stdout', () => {
  const { kernel, getOut } = makeKernel();
  installUserland(kernel);
  kernel.fs.writeFile('/motd', bytes('the quick brown fox\n'));
  kernel.spawnFromFile('cat', '/bin/cat', ['cat', '/motd']);
  kernel.run();
  assert.equal(getOut(), 'the quick brown fox\n');
});

test('ls lists the entries of a directory', () => {
  const { kernel, getOut } = makeKernel();
  installUserland(kernel);
  kernel.fs.writeFile('/a.txt', bytes('a'));
  kernel.fs.writeFile('/b.txt', bytes('b'));
  kernel.spawnFromFile('ls', '/bin/ls', ['ls', '/']);
  kernel.run();
  const names = getOut()
    .split('\n')
    .filter((s) => s.length > 0);
  assert.ok(names.includes('.'), names.join(','));
  assert.ok(names.includes('a.txt'), names.join(','));
  assert.ok(names.includes('b.txt'), names.join(','));
  assert.ok(names.includes('bin'), names.join(','));
});

test('the shell runs a script of commands from stdin (boot -> sh -> ls)', () => {
  const { kernel, getOut } = makeKernel();
  installUserland(kernel);
  kernel.fs.writeFile('/hello.txt', bytes('hi from disk\n'));

  // Feed a command script as stdin; the shell reads it line by line and exits at EOF.
  kernel.feedInput('echo boot ok\nls /\ncat /hello.txt\n');
  kernel.closeInput(); // EOF -> the shell quits after the script
  kernel.spawnFromFile('init', '/bin/init');
  kernel.run();

  const out = getOut();
  assert.ok(out.includes('boot ok\n'), out);
  assert.ok(out.includes('hello.txt\n'), out); // ls listed it
  assert.ok(out.includes('hi from disk\n'), out); // cat printed it
  assert.ok(out.includes('$ '), out); // the prompt was shown
  assert.equal(kernel.processes.get(1)!.state, 'zombie'); // init exited at EOF
});

test('the shell reports an unknown command but keeps running', () => {
  const { kernel, getOut } = makeKernel();
  installUserland(kernel);
  kernel.feedInput('nope\necho still here\n');
  kernel.closeInput();
  kernel.spawnFromFile('init', '/bin/init');
  kernel.run();
  const out = getOut();
  assert.ok(out.includes('sh: ?\n'), out);
  assert.ok(out.includes('still here\n'), out);
});
