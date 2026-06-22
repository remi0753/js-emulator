import { buildPhase11KernelImage, PHASE11_KERNEL_LAYOUT } from '../src/v3/guest-kernel.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

const image = buildPhase11KernelImage();
const machine = new Machine({ physSize: 1024 * 1024 });

machine.load(0, image.flat);
machine.reset({ pc: image.entry, sp: PHASE11_KERNEL_LAYOUT.stackTop });

const result = machine.run(250_000);

const sym = (name: string) => machine.phys.read32(image.symbols.get(name)!);

console.log('');
console.log(`[phase11] run result: ${result.reason}`);
console.log(`[phase11] paging: ${machine.cpu.pagingEnabled ? 'on' : 'off'} ptbr=0x${machine.cpu.ptbr.toString(16)}`);
console.log(
  `[phase11] pf_count=${sym('pf_count')} pfla=0x${sym('page_fault_addr').toString(16)} value=0x${sym('deliberate_value').toString(16)}`,
);
console.log(`[phase11] ticks=${sym('ticks')} idle_count=${sym('idle_count')}`);
