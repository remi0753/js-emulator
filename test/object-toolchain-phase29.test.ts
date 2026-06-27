import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { encodeArchive, parseArchive } from '../src/formats/archive.ts';
import { encodeObject, parseObject } from '../src/formats/object.ts';
import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import { assembleObject } from '../src/toolchain/as.ts';
import { dump } from '../src/toolchain/dump.ts';
import { flattenGuestExecutable, linkObjects } from '../src/toolchain/object-linker.ts';
import {
  buildGuestDiskImage,
  buildGuestKernelImage,
  GUEST_EXECUTABLE_MAGIC,
  GUEST_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

const USER_BASE = GUEST_KERNEL_LAYOUT.userLoadBase;

// --- hand-written assembly translation units ------------------------------

// libio member 1: puts(R1=NUL-terminated string) writes it to fd 1.
const PUTS_SRC = `
.global puts
.text
puts:
  MOVR R2, R1        ; scan pointer
  MOV  R3, 0         ; length
  MOV  R5, 0         ; NUL
puts_scan:
  LB   R4, R2
  CMP  R4, R5
  JZ   puts_write
  INC  R2
  INC  R3
  JMP  puts_scan
puts_write:
  MOVR R2, R1        ; buf = string
  MOV  R1, 1         ; fd = stdout
  MOV  R0, 1         ; SYS_WRITE
  INT  0x80
  RET
`;

// libio member 2: putdigit(R1=0..9) writes a single ASCII digit to fd 1.
const PUTDIGIT_SRC = `
.global putdigit
.text
putdigit:
  MOV  R4, '0'
  ADD  R1, R4        ; '0' + digit
  MOV  R5, digit_buf
  SB   R5, R1
  MOV  R2, digit_buf
  MOV  R3, 1
  MOV  R1, 1
  MOV  R0, 1         ; SYS_WRITE
  INT  0x80
  RET
.bss
digit_buf:
  .space 1
`;

// /bin/child: prints a line via the library, then exits with status 7.
const CHILD_SRC = `
.global _start
.text
_start:
  MOV  R1, child_msg
  CALL puts
  MOV  R1, 7         ; exit code
  MOV  R0, 0         ; SYS_EXIT
  INT  0x80
child_hang:
  JMP  child_hang
.data
child_msg:
  .string "hello from child\\n"
`;

// /bin/hello (parent): announces itself, forks/execs /bin/child, waits, and
// prints the child's decoded exit status, then exits 0.
const PARENT_SRC = `
.global _start
.text
_start:
  MOV  R1, hello_msg
  CALL puts
  MOV  R0, 4         ; SYS_FORK
  INT  0x80
  MOV  R5, 0
  CMP  R0, R5
  JZ   run_child
  ; parent: wait for the child and decode its exit status
  MOV  R1, wstatus
  MOV  R0, 6         ; SYS_WAIT
  INT  0x80
  LOAD R1, wstatus   ; status = exit_code << 8
  MOV  R2, 8
  SHR  R1, R2
  MOV  R4, 0xff
  AND  R1, R4        ; exit code
  PUSH R1
  MOV  R1, exited_msg
  CALL puts
  POP  R1
  CALL putdigit
  MOV  R1, nl_msg
  CALL puts
  MOV  R1, 0
  MOV  R0, 0         ; SYS_EXIT
  INT  0x80
parent_hang:
  JMP  parent_hang
run_child:
  MOV  R1, child_path
  MOV  R2, 0         ; argv = NULL
  MOV  R3, 0         ; envp = NULL
  MOV  R0, 5         ; SYS_EXEC
  INT  0x80
  MOV  R1, 1         ; exec failed -> exit 1
  MOV  R0, 0
  INT  0x80
.data
hello_msg:
  .string "parent start\\n"
exited_msg:
  .string "child exited "
nl_msg:
  .string "\\n"
child_path:
  .string "/bin/child"
.bss
wstatus:
  .space 4
`;

function buildLibio(): Uint8Array {
  return encodeArchive({
    members: [
      { name: 'io_puts.o', data: encodeObject(assembleObject(PUTS_SRC, 'io_puts.o')) },
      { name: 'io_putdigit.o', data: encodeObject(assembleObject(PUTDIGIT_SRC, 'io_putdigit.o')) },
    ],
  });
}

function installFs(image: Uint8Array): Fs {
  const ports = new PortBus();
  const blk = new BlockDisk(image);
  ports.register(PORT.DISK_DATA, 1, blk);
  ports.register(PORT.DISK_POS, 1, blk);
  ports.register(PORT.DISK_SECTORS, 1, blk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  return fs;
}

// --- object/archive format unit tests -------------------------------------

test('objects and archives round-trip through their binary encoding', () => {
  const obj = assembleObject(PARENT_SRC, 'parent.o');
  const decoded = parseObject(encodeObject(obj));
  assert.equal(decoded.name, 'parent.o');
  assert.deepEqual([...decoded.text], [...obj.text]);
  assert.deepEqual([...decoded.data], [...obj.data]);
  assert.equal(decoded.bssSize, obj.bssSize);
  assert.deepEqual(decoded.symbols, obj.symbols);
  assert.deepEqual(decoded.relocs, obj.relocs);

  const archive = buildLibio();
  const members = parseArchive(archive).members;
  assert.deepEqual(
    members.map((m) => m.name),
    ['io_puts.o', 'io_putdigit.o'],
  );
});

test('the assembler records globals, locals, undefined refs, and relocations', () => {
  const obj = assembleObject(PARENT_SRC, 'parent.o');
  const byName = new Map(obj.symbols.map((s) => [s.name, s]));

  assert.equal(byName.get('_start')?.binding, 'global');
  assert.equal(byName.get('_start')?.section, 'text');
  // referenced-but-not-defined library helpers are undefined globals
  assert.equal(byName.get('puts')?.section, 'undef');
  assert.equal(byName.get('putdigit')?.section, 'undef');
  // a local data label and a bss reservation
  assert.equal(byName.get('hello_msg')?.section, 'data');
  assert.equal(byName.get('hello_msg')?.binding, 'local');
  assert.equal(byName.get('wstatus')?.section, 'bss');
  // every symbol reference produced a relocation
  assert.ok(obj.relocs.some((r) => obj.symbols[r.symbol]?.name === 'puts'));
  assert.ok(obj.relocs.some((r) => obj.symbols[r.symbol]?.name === 'wstatus'));
});

test('the linker applies absolute relocations against placed sections', () => {
  // main references an external `value` symbol via a `.word`; the linker must
  // patch the data word with `value`'s resolved address.
  const main = assembleObject(
    `
    .global _start
    .text
    _start:
      LOAD R0, slot
      RET
    .data
    slot:
      .word value
    `,
    'main.o',
  );
  const lib = assembleObject(
    `
    .global value
    .data
    value:
      .word 0xcafe
    `,
    'lib.o',
  );
  const linked = linkObjects([main, lib], [], { textOrigin: 0x1000 });
  const valueAddr = linked.symbols.get('value');
  assert.ok(valueAddr !== undefined);
  // data segment is the second segment; find `slot`'s 4 bytes (first word).
  const data = linked.executable.segments[1]!.data;
  const patched = data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24);
  assert.equal(patched >>> 0, valueAddr);
});

test('the linker reports undefined and duplicate symbols', () => {
  const needsExternal = assembleObject(
    '.global _start\n.text\n_start:\n  CALL missing\n  RET\n',
    'a.o',
  );
  assert.throws(() => linkObjects([needsExternal], [], {}), /undefined symbol/);

  const dupA = assembleObject('.global _start\n.text\n_start:\n  RET\n', 'a.o');
  const dupB = assembleObject('.global _start\n.text\n_start:\n  RET\n', 'b.o');
  assert.throws(() => linkObjects([dupA, dupB], [], {}), /duplicate global symbol/);
});

test('archive search pulls only the members that satisfy undefined symbols', () => {
  const libio = parseArchive(buildLibio());
  // child needs only `puts`, so `putdigit` must not be pulled into the image.
  const child = assembleObject(CHILD_SRC, 'child.o');
  const childLink = linkObjects([child], [libio], { textOrigin: USER_BASE });
  assert.ok(childLink.symbols.has('puts'));
  assert.ok(!childLink.symbols.has('putdigit'));

  // parent needs both helpers.
  const parent = assembleObject(PARENT_SRC, 'parent.o');
  const parentLink = linkObjects([parent], [libio], { textOrigin: USER_BASE });
  assert.ok(parentLink.symbols.has('puts'));
  assert.ok(parentLink.symbols.has('putdigit'));
});

test('the dumper renders objects and archives readably', () => {
  const objDump = dump(encodeObject(assembleObject(PARENT_SRC, 'parent.o')));
  assert.match(objDump, /object: parent\.o/);
  assert.match(objDump, /GLOBAL TEXT .* _start/);
  assert.match(objDump, /GLOBAL UND\s+puts/);
  assert.match(objDump, /abs32 child_path/);

  const arDump = dump(buildLibio());
  assert.match(arDump, /archive: 2 member\(s\)/);
  assert.match(arDump, /io_puts\.o/);
  assert.match(arDump, /provides: puts/);
  assert.match(arDump, /provides: putdigit/);
});

// --- end-to-end: assemble, archive, link, install, run --------------------

test('hand-written assembly objects + an archive boot, run, and report exit status', () => {
  const libio = parseArchive(buildLibio());
  const childExe = flattenGuestExecutable(
    linkObjects([assembleObject(CHILD_SRC, 'child.o')], [libio], { textOrigin: USER_BASE }),
    USER_BASE,
    GUEST_EXECUTABLE_MAGIC,
  );
  const parentExe = flattenGuestExecutable(
    linkObjects([assembleObject(PARENT_SRC, 'parent.o')], [libio], { textOrigin: USER_BASE }),
    USER_BASE,
    GUEST_EXECUTABLE_MAGIC,
  );

  const disk = buildGuestDiskImage();
  const fs = installFs(disk);
  fs.writeFile('/bin/child', childExe);
  fs.chmod('/bin/child', 0o755);
  fs.writeFile('/bin/hello', parentExe);
  fs.chmod('/bin/hello', 0o755);

  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (s) => (out += s),
  });
  machine.keyboard.feed('hello\n');
  machine.keyboard.close();
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  const result = machine.run(40_000_000);
  assert.equal(result.reason, 'halt');
  // parent prints first, then the exec'd child, then the decoded exit status.
  const expected = 'parent start\nhello from child\nchild exited 7\n';
  assert.ok(out.includes(expected), `missing expected sequence in:\n${out}`);
});

// --- the host CLI tools also drive the same pipeline ----------------------

test('custom32-as/ar/ld/objdump work as command-line host tools', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'custom32-'));
  const run = (tool: string, args: string[]) => {
    const r = spawnSync(
      process.execPath,
      ['--experimental-strip-types', join(root, 'tools', tool), ...args],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `${tool} failed: ${r.stderr}`);
    return r.stdout;
  };

  writeFileSync(join(dir, 'puts.s'), PUTS_SRC);
  writeFileSync(join(dir, 'putdigit.s'), PUTDIGIT_SRC);
  writeFileSync(join(dir, 'child.s'), CHILD_SRC);

  run('custom32-as.ts', ['-o', join(dir, 'puts.o'), join(dir, 'puts.s')]);
  run('custom32-as.ts', ['-o', join(dir, 'putdigit.o'), join(dir, 'putdigit.s')]);
  run('custom32-as.ts', ['-o', join(dir, 'child.o'), join(dir, 'child.s')]);
  run('custom32-ar.ts', ['rc', join(dir, 'libio.a'), join(dir, 'puts.o'), join(dir, 'putdigit.o')]);

  const listing = run('custom32-ar.ts', ['t', join(dir, 'libio.a')]);
  assert.match(listing, /puts\.o/);
  assert.match(listing, /putdigit\.o/);

  run('custom32-ld.ts', ['-o', join(dir, 'child'), join(dir, 'child.o'), join(dir, 'libio.a')]);

  const objdump = run('custom32-objdump.ts', [join(dir, 'child.o')]);
  assert.match(objdump, /object: child\.o/);
  assert.match(objdump, /GLOBAL UND\s+puts/);

  // The CLI-produced executable matches the in-process pipeline byte for byte
  // and carries the guest loader's magic.
  const cliExe = new Uint8Array(readFileSync(join(dir, 'child')));
  const libExe = flattenGuestExecutable(
    linkObjects([assembleObject(CHILD_SRC, 'child.o')], [parseArchive(buildLibio())], {
      textOrigin: USER_BASE,
    }),
    USER_BASE,
    GUEST_EXECUTABLE_MAGIC,
  );
  assert.deepEqual([...cliExe], [...libExe]);
  const magic = cliExe[0]! | (cliExe[1]! << 8) | (cliExe[2]! << 16) | (cliExe[3]! << 24);
  assert.equal(magic >>> 0, GUEST_EXECUTABLE_MAGIC);
});
