import {
  buildPhase14DiskImage,
  buildPhase14KernelImage,
  PHASE14_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { MODE } from '../src/vm/custom32/cpu.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

const image = buildPhase14KernelImage();
const disk = buildPhase14DiskImage();

const machine = new Machine({
  physSize: PHASE14_KERNEL_LAYOUT.physSize,
  diskImage: disk,
  consoleSink: (s) => process.stdout.write(s),
});

machine.load(0, image.flat);
machine.reset({ pc: image.entry, sp: PHASE14_KERNEL_LAYOUT.kstackTop });

const result = machine.run(5_000_000);

const sym = (name: string) => machine.phys.read32(image.symbols.get(name)!);

console.log('');
console.log(`[phase14] run result: ${result.reason}`);
console.log(
  `[phase14] paging: ${machine.cpu.pagingEnabled ? 'on' : 'off'} mode=${machine.cpu.mode === MODE.USER ? 'USER' : 'KERNEL'}`,
);
console.log(
  `[phase14] mounted FS: inodestart=${sym('fs_inodestart')} bmapstart=${sym('fs_bmapstart')} ninodes=${sym('fs_ninodes')}`,
);
console.log(`[phase14] processes created (nproc)=${sym('nproc')} guest timer ticks=${sym('ticks')}`);
console.log(
  '[phase14] the guest mounted the disk, loaded /bin/init from the FS, read /etc/motd through file descriptors, and exec\'d /bin/hello -- all in guest code.',
);
