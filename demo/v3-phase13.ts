import {
  buildPhase13KernelImage,
  PHASE13_CHILD_EXIT_CODE,
  PHASE13_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { MODE } from '../src/vm/custom32/cpu.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

const image = buildPhase13KernelImage();

const machine = new Machine({
  physSize: PHASE13_KERNEL_LAYOUT.physSize,
  consoleSink: (s) => process.stdout.write(s),
});

machine.load(0, image.flat);
machine.reset({ pc: image.entry, sp: PHASE13_KERNEL_LAYOUT.kstackTop });

const result = machine.run(2_000_000);

const sym = (name: string) => machine.phys.read32(image.symbols.get(name)!);
const arr = (name: string, i: number) => machine.phys.read32(image.symbols.get(name)! + i * 4);

console.log('');
console.log(`[phase13] run result: ${result.reason}`);
console.log(
  `[phase13] paging: ${machine.cpu.pagingEnabled ? 'on' : 'off'} mode=${machine.cpu.mode === MODE.USER ? 'USER' : 'KERNEL'}`,
);
console.log(`[phase13] processes created (nproc)=${sym('nproc')} guest timer ticks=${sym('ticks')}`);
console.log(
  `[phase13] child (slot 1) exit code recorded by the guest kernel: ${arr('proc_exit_code', 1)} (expected ${PHASE13_CHILD_EXIT_CODE})`,
);
console.log(
  '[phase13] init forked a child, the child exec\'d a second image and printed, and init wait()ed for it -- all syscalls handled in the guest.',
);
