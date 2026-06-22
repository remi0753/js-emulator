// v2 Phase 5/6 demo: boot to a shell and run commands.
//
// The v2 acceptance target: boot the kernel, reach an interactive shell, and run
// `ls`. The kernel formats a disk, installs userland (/bin/init, /bin/sh,
// /bin/{echo,cat,ls}), seeds a couple of files, then boots /bin/init -> /bin/sh.
//
// In a real terminal this is *interactive*: keystrokes go to the keyboard device
// and the shell blocks on read() until you type (Phase 6 blocking I/O). When
// stdin is not a TTY (tests/pipes) it falls back to a scripted session. Type
// commands like `ls /`, `cat /README`, `echo hi`; Ctrl-D quits.
//
// Run: node demo/v2-shell.ts

import { Kernel } from '../src/v2/kernel/kernel.ts';
import { installUserland } from '../src/v2/userland/programs.ts';

const kernel = new Kernel({ quantum: 200, log: () => {} });
installUserland(kernel);

const text = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
kernel.fs.writeFile('/etc/motd', text('jscpu-os v2 - booted to a shell!\n'));
kernel.fs.writeFile('/README', text('hello from the on-disk filesystem\n'));

console.log('=== v2: boot -> shell -> ls (acceptance target) ===\n');
kernel.spawnFromFile('init', '/bin/init');

if (process.stdin.isTTY) {
  // Interactive: feed real keystrokes to the keyboard; run() resumes the blocked
  // shell each time input arrives (this is the keyboard "IRQ" driving the CPU).
  kernel.run(); // prints the first prompt, then blocks reading stdin
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk: Buffer) => {
    for (const byte of chunk) {
      if (byte === 3) process.exit(0); // Ctrl-C
      if (byte === 4) {
        kernel.closeInput(); // Ctrl-D = EOF
        continue;
      }
      const ch = byte === 13 ? '\n' : String.fromCharCode(byte);
      process.stdout.write(ch); // echo the keypress
      kernel.feedInput(ch);
    }
    kernel.run();
    if (!kernel.hasLiveProcesses) {
      process.stdin.setRawMode(false);
      process.exit(0);
    }
  });
} else {
  // Non-interactive: run a scripted session and quit at EOF.
  const script = ['echo hello world', 'ls /', 'ls /bin', 'cat /README', 'nope'];
  console.log('(no TTY -> scripted session)\n');
  kernel.feedInput(`${script.join('\n')}\n`);
  kernel.closeInput();
  kernel.run();
  console.log('\n--- process table: ---');
  for (const p of kernel.processes.values()) {
    console.log(`  pid=${p.pid} name=${p.name} state=${p.state} exit=${p.exitCode}`);
  }
}
