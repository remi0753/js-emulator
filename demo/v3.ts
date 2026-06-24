import { bootGuestDiskImage } from '../src/v3/boot.ts';
import { buildGuestDiskImage } from '../src/v3/guest-kernel.ts';
import { MODE } from '../src/vm/custom32/cpu.ts';

const disk = buildGuestDiskImage();
const { machine } = bootGuestDiskImage(disk, {
  consoleSink: (s) => process.stdout.write(s),
  rtcTime: 1700000000, // a fixed wall clock so the demo output is deterministic
});

// Feed the shell a script: print the RTC time, then power the machine off.
machine.keyboard.feed('date\nshutdown\n');

const result = machine.run(20_000_000);

console.log('');
console.log(`[guest] run result: ${result.reason}`);
console.log(`[guest] powered off via device: ${machine.power.poweredOff}`);
console.log(
  `[guest] paging: ${machine.cpu.pagingEnabled ? 'on' : 'off'} mode=${machine.cpu.mode === MODE.USER ? 'USER' : 'KERNEL'}`,
);
console.log('[guest] /bin/date read the RTC and /bin/shutdown drove the power device.');
