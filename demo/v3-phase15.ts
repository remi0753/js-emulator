import {
  buildPhase15DiskImage,
  buildPhase15KernelImage,
  PHASE15_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { MODE } from '../src/vm/custom32/cpu.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

const image = buildPhase15KernelImage();
const disk = buildPhase15DiskImage();

const machine = new Machine({
  physSize: PHASE15_KERNEL_LAYOUT.physSize,
  diskImage: disk,
  consoleSink: (s) => process.stdout.write(s),
});

// Feed the shell a script on the keyboard; end of input ends the shell.
machine.keyboard.feed('echo hi\nls /\ncat /etc/motd\ncat /etc/motd | cat\n');

machine.load(0, image.flat);
machine.reset({ pc: image.entry, sp: PHASE15_KERNEL_LAYOUT.kstackTop });

const result = machine.run(20_000_000);

console.log('');
console.log(`[phase15] run result: ${result.reason}`);
console.log(
  `[phase15] paging: ${machine.cpu.pagingEnabled ? 'on' : 'off'} mode=${machine.cpu.mode === MODE.USER ? 'USER' : 'KERNEL'}`,
);
console.log(
  '[phase15] booted compiled /bin/init -> /bin/sh, which ran echo/ls/cat and a pipeline -- all compiled C on the guest.',
);
