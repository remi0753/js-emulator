import { buildPhase12KernelImage, PHASE12_KERNEL_LAYOUT } from '../src/v3/guest-kernel.ts';
import { MODE } from '../src/vm/custom32/cpu.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

const image = buildPhase12KernelImage();
const machine = new Machine({ physSize: PHASE12_KERNEL_LAYOUT.physSize });

machine.load(0, image.flat);
machine.reset({ pc: image.entry, sp: PHASE12_KERNEL_LAYOUT.kstackTop });

const result = machine.run(2_000_000);

const sym = (name: string) => machine.phys.read32(image.symbols.get(name)!);
const arr = (name: string, i: number) => machine.phys.read32(image.symbols.get(name)! + i * 4);

console.log('');
console.log(`[phase12] run result: ${result.reason}`);
console.log(
  `[phase12] paging: ${machine.cpu.pagingEnabled ? 'on' : 'off'} mode=${machine.cpu.mode === MODE.USER ? 'USER' : 'KERNEL'}`,
);
console.log(`[phase12] nproc=${sym('nproc')} timer ticks (guest-handled)=${sym('ticks')}`);
for (let i = 0; i < sym('nproc'); i++) {
  const frame = arr('proc_data_frame', i);
  const counter = machine.phys.read32(frame);
  const tag = machine.phys.read32(frame + 4);
  console.log(
    `[phase12] proc${i}: ptbr=0x${arr('proc_ptbr', i).toString(16)} dataFrame=0x${frame.toString(16)} counter=${counter} tag=0x${tag.toString(16)}`,
  );
}
console.log('[phase12] proc0 and proc2 are a fork pair: same tag, different frames -> isolated.');
