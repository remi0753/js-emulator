// v2 Phase 7 demo: the hardware boundary (model-B foundation).
//
// This demo uses NO kernel — no scheduler, process table, syscall dispatch, or
// VFS. It drives the bare Machine directly: load guest bytes at a physical
// address, reset the CPU, and run until the guest halts. A Tracer records the
// instruction stream, every return-to-host trap, port I/O, and disk transfers —
// the deterministic observability model-B guest kernels will be debugged with.
//
// Run: node demo/v2-machine.ts

import { assemble } from '../src/assembler.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { formatTrap } from '../src/vm/custom32/trace.ts';

// A tiny "guest kernel": print "HI\n" through the console port, stash a word on
// the disk, read it back, then halt. All bare-metal, in KERNEL mode, paging off.
const guest = assemble(`
    MOV R1, ${PORT.CONSOLE_DATA}
    MOV R2, 72            ; 'H'
    OUT R1, R2
    MOV R2, 73            ; 'I'
    OUT R1, R2
    MOV R2, 10            ; '\\n'
    OUT R1, R2

    MOV R1, ${PORT.DISK_POS}
    MOV R2, 0
    OUT R1, R2            ; seek to sector 0
    MOV R1, ${PORT.DISK_DATA}
    MOV R2, 0xc0ffee
    OUT R1, R2            ; write a word to the disk

    MOV R1, ${PORT.DISK_POS}
    MOV R2, 0
    OUT R1, R2            ; seek back
    MOV R1, ${PORT.DISK_DATA}
    IN  R0, R1            ; read it back into R0
    HLT
`).bytes;

const machine = new Machine({ physSize: 64 * 1024, diskBlocks: 8, trace: true });
const tracer = machine.tracer!;

console.log('=== v2 Phase 7: booting a guest through the hardware boundary ===\n');
console.log('console output:');
process.stdout.write('  ');

machine.load(0, guest); // load the guest at physical address 0
machine.reset(); // pc=0, KERNEL mode, paging off
const result = machine.run(1000); // run until the guest stops

console.log(`\nstopped: ${formatTrap(result)}`);
console.log(`R0 read back from disk: 0x${(machine.cpu.regs[0] ?? 0).toString(16)}\n`);

console.log(`=== deterministic trace (${tracer.instr.length} instructions) ===`);
console.log(tracer.toText());
