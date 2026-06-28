import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fs } from '../src/storage/fs.ts';
import { PortBlockDevice } from '../src/storage/port-block-device.ts';
import {
  buildGuestDiskImage,
  buildGuestKernelImage,
  buildUserExecutable,
  GUEST_KERNEL_LAYOUT,
} from '../src/v3/guest-kernel.ts';
import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { Machine } from '../src/vm/custom32/machine.ts';
import { PORT } from '../src/vm/custom32/platform.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';

function addProgram(disk: Uint8Array, name: string, source: string): void {
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(`/bin/${name}`, buildUserExecutable(name, source));
  fs.chmod(`/bin/${name}`, 0o755);
}

function boot(disk: Uint8Array, input: string): { machine: Machine; output: () => string } {
  const image = buildGuestKernelImage();
  let out = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (out += text),
  });
  machine.keyboard.feed(input);
  machine.load(0, image.flat);
  machine.reset({ pc: image.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });
  return { machine, output: () => out };
}

test('caught and blocked signals run a user handler and return through sigreturn', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'sigcheck',
    `
      int caught;
      void on_signal(int signal_number) {
        caught = signal_number;
      }
      int main(int argc, char **argv) {
        int old_mask;
        caught = 0;
        if (signal(10, on_signal) < 0) return 1;
        if (sigprocmask(0, 1 << 10, &old_mask) < 0) return 2;
        if (kill(getpid(), 10) < 0) return 3;
        if (caught != 0) return 4;
        if (sigprocmask(1, 1 << 10, 0) < 0) return 5;
        if (caught != 10) return 6;
        write(1, "signal-ok\\n", 10);
        return 0;
      }
    `,
  );
  const { machine, output } = boot(disk, 'sigcheck\n');
  machine.keyboard.close();

  assert.equal(machine.run(30_000_000).reason, 'halt');
  assert.equal(output().includes('signal-ok\n'), true);
  assert.equal(output().includes('PANIC'), false);
});

test('a caught signal interrupts a blocking syscall with EINTR', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'eintr',
    `
      extern int errno;
      int caught;
      void on_signal(int signal_number) {
        caught = signal_number;
      }
      int main(int argc, char **argv) {
        int fds[2];
        int pid;
        int status;
        int fd;
        int n;
        char byte;
        char path[32];
        char buf[256];
        char *state;
        pipe(fds);
        pid = fork();
        if (pid == 0) {
          close(fds[1]);
          signal(10, on_signal);
          if (read(fds[0], &byte, 1) != -1) exit(1);
          if (errno != 4 || caught != 10) exit(2);
          write(1, "EINTR-ok\\n", 9);
          exit(0);
        }
        close(fds[0]);
        // Wait until the child is actually blocked in read() (State 'S' in
        // /proc) before signalling, so the signal deterministically interrupts
        // the syscall instead of racing the scheduler over handler delivery.
        snprintf(path, 32, "/proc/%d/status", pid);
        while (1) {
          fd = open(path, 0);
          n = read(fd, buf, 255);
          close(fd);
          if (n < 0) n = 0;
          buf[n] = 0;
          state = strstr(buf, "State:");
          if (state != 0 && state[7] == 'S') break;
        }
        kill(pid, 10);
        waitpid(pid, &status, 0);
        close(fds[1]);
        return 0;
      }
    `,
  );
  const { machine, output } = boot(disk, 'eintr\n');
  machine.keyboard.close();

  // Budget includes the 64 MiB identity-map build during boot.
  assert.equal(machine.run(55_000_000).reason, 'halt');
  assert.equal(output().includes('EINTR-ok\n'), true, output());
});

test('waitpid reports stopped and continued children before final signal exit', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'waitsig',
    `
      int main(int argc, char **argv) {
        int pid;
        int status;
        pid = fork();
        if (pid == 0) {
          while (1) {
          }
        }
        if (kill(pid, 19) < 0) return 1;
        if (waitpid(pid, &status, 2) != pid) return 2;
        if ((status & 255) != 127) return 3;
        if (kill(pid, 18) < 0) return 4;
        if (waitpid(pid, &status, 4) != pid) return 5;
        if (status != 65535) return 6;
        if (kill(pid, 15) < 0) return 7;
        if (waitpid(pid, &status, 0) != pid) return 8;
        if ((status & 127) != 15) return 9;
        write(1, "waitpid-ok\\n", 11);
        return 0;
      }
    `,
  );
  const { machine, output } = boot(disk, 'waitsig\n');
  machine.keyboard.close();

  assert.equal(machine.run(40_000_000).reason, 'halt');
  assert.equal(output().includes('waitpid-ok\n'), true);
  assert.equal(output().includes('PANIC'), false);
});

test('the shell runs background jobs and Ctrl-C interrupts its foreground group', () => {
  const { machine, output } = boot(buildGuestDiskImage(), 'echo background &\nspin\n');

  const spinning = machine.run(40_000_000);
  assert.notEqual(spinning.reason, 'halt');
  assert.equal(output().includes('background\n'), true);

  machine.keyboard.feed('\x03');
  const interrupted = machine.run(20_000_000);
  assert.equal(interrupted.reason, 'halt');
  assert.equal(output().includes('all processes exited'), false);

  machine.keyboard.feed('echo survived\n');
  machine.keyboard.close();
  const done = machine.run(30_000_000);
  assert.equal(done.reason, 'halt');
  assert.equal(output().includes('survived\n'), true);
  assert.equal(output().endsWith('kernel: all processes exited\n'), true);
});

test('ignored signals do not interrupt sleep, SIGCHLD is delivered, and signal returns the old handler', () => {
  const disk = buildGuestDiskImage();
  addProgram(
    disk,
    'sigedge',
    `
      extern int errno;
      int child_signal;
      void first(int signal_number) { }
      void second(int signal_number) { }
      void on_child(int signal_number) { child_signal = signal_number; }

      int main(int argc, char **argv) {
        int fds[2];
        int ready[2];
        int pid;
        int status;
        int i;
        int old;
        char byte;

        old = signal(10, first);
        if (old != 0) return 1;
        old = signal(10, second);
        if (old != first) return 2;

        child_signal = 0;
        if (signal(17, on_child) < 0) return 3;
        pid = fork();
        if (pid == 0) exit(0);
        if (waitpid(pid, &status, 0) != pid || child_signal != 17) return 4;

        if (pipe(fds) < 0) return 5;
        if (pipe(ready) < 0) return 6;
        pid = fork();
        if (pid == 0) {
          close(fds[1]);
          close(ready[0]);
          signal(10, 1);
          write(ready[1], "r", 1);
          close(ready[1]);
          if (read(fds[0], &byte, 1) != 1 || byte != 'x') exit(6);
          exit(0);
        }
        close(fds[0]);
        close(ready[1]);
        if (read(ready[0], &byte, 1) != 1 || byte != 'r') return 7;
        close(ready[0]);
        i = 0;
        while (i < 4) {
          __syscall(2, 0, 0, 0);
          i = i + 1;
        }
        kill(pid, 10);
        i = 0;
        while (i < 4) {
          __syscall(2, 0, 0, 0);
          i = i + 1;
        }
        if (write(fds[1], "x", 1) != 1) return 8;
        close(fds[1]);
        if (waitpid(pid, &status, 0) != pid || status != 0) return 9;
        write(1, "signal-edge-ok\\n", 15);
        return 0;
      }
    `,
  );
  const { machine, output } = boot(disk, 'sigedge\n');
  machine.keyboard.close();

  assert.equal(machine.run(50_000_000).reason, 'halt');
  assert.equal(output().includes('signal-edge-ok\n'), true, output());
  assert.equal(output().includes('PANIC'), false, output());
});
