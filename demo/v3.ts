import {
  buildGuestDiskImage,
  buildGuestKernelImage,
  GUEST_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { MODE } from '../src/vm/custom32/cpu.ts';
import { Machine } from '../src/vm/custom32/machine.ts';

const image = buildGuestKernelImage();
const disk = buildGuestDiskImage();

const machine = new Machine({
  physSize: GUEST_KERNEL_LAYOUT.physSize,
  diskImage: disk,
  consoleSink: (s) => process.stdout.write(s),
  rtcTime: 1700000000, // a fixed wall clock so the demo output is deterministic
});

// Feed the shell a script: print the RTC time, then power the machine off.
machine.keyboard.feed('date\nshutdown\n');

machine.load(0, image.flat);
machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

const result = machine.run(20_000_000);

console.log('');
console.log(`[guest] run result: ${result.reason}`);
console.log(`[guest] powered off via device: ${machine.power.poweredOff}`);
console.log(
  `[guest] paging: ${machine.cpu.pagingEnabled ? 'on' : 'off'} mode=${machine.cpu.mode === MODE.USER ? 'USER' : 'KERNEL'}`,
);
console.log('[guest] /bin/date read the RTC and /bin/shutdown drove the power device.');
