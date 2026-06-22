// v2 Phase 5 demo: userland — boot to a shell and run commands.
//
// This is the v2 acceptance target: boot the kernel, reach an interactive shell,
// and run `ls` to list the files on the mounted disk. The kernel formats a disk,
// installs userland (/bin/init, /bin/sh, /bin/{echo,cat,ls}), seeds a couple of
// files, then boots /bin/init — which execs the shell. A command script is fed on
// stdin (the live keyboard arrives in Phase 6); the shell fork/exec/waits each
// command. Every layer built in Phases 1-5 runs end to end here.
//
// Run: node demo/v2-shell.ts

import { Kernel } from '../src/v2/kernel/kernel.ts';
import { installUserland } from '../src/v2/userland/programs.ts';

const kernel = new Kernel({ quantum: 200, log: () => {} });
installUserland(kernel);

// Seed a small filesystem.
const text = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
kernel.fs.writeFile('/etc/motd', text('jscpu-os v2 - booted to a shell!\n'));
kernel.fs.writeFile('/README', text('hello from the on-disk filesystem\n'));

// The command "session" (stdin). With the keyboard (Phase 6) you would type these.
const script = ['echo hello world', 'ls /', 'ls /bin', 'cat /README', 'nope', ''].join('\n');

console.log('=== v2: boot -> shell -> ls (acceptance target) ===\n');
console.log('--- feeding this session on stdin: ---');
for (const line of script.split('\n')) if (line) console.log(`    $ ${line}`);
console.log('\n--- console output: ---');

kernel.feedInput(`${script}\n`);
kernel.spawnFromFile('init', '/bin/init');
kernel.run();

console.log('\n--- done; process table: ---');
for (const p of kernel.processes.values()) {
  console.log(`  pid=${p.pid} name=${p.name} state=${p.state} exit=${p.exitCode}`);
}
