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

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    sum += (bytes[i]! << 8) | (bytes[i + 1] ?? 0);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return ~sum & 0xffff;
}

function udpFrame(
  payload: string,
  options: {
    sourceLast?: number;
    sourcePort?: number;
    udpLengthExtra?: number;
    padding?: number;
    udpChecksum?: number;
    fragment?: number;
    corruptIpChecksum?: boolean;
  } = {},
): Uint8Array {
  const data = new TextEncoder().encode(payload);
  const padding = options.padding ?? 0;
  const frame = new Uint8Array(14 + 20 + 8 + data.length + padding);
  frame.set([0x02, 0, 0, 0, 0, 2, 0x02, 0, 0, 0, 0, 1, 0x08, 0x00]);
  frame.set(
    [
      0x45,
      0,
      0,
      28 + data.length,
      0,
      1,
      0,
      0,
      64,
      17,
      0,
      0,
      10,
      0,
      2,
      options.sourceLast ?? 2,
      10,
      0,
      2,
      15,
    ],
    14,
  );
  const ipChecksum = checksum(frame.subarray(14, 34));
  frame[24] = ipChecksum >>> 8;
  frame[25] = ipChecksum & 0xff;
  if (options.fragment !== undefined) {
    frame[20] = options.fragment >>> 8;
    frame[21] = options.fragment & 0xff;
    frame[24] = 0;
    frame[25] = 0;
    const nextChecksum = checksum(frame.subarray(14, 34));
    frame[24] = nextChecksum >>> 8;
    frame[25] = nextChecksum & 0xff;
  }
  if (options.corruptIpChecksum) frame[24] ^= 0xff;
  const sourcePort = options.sourcePort ?? 12345;
  const udpLength = 8 + data.length + (options.udpLengthExtra ?? 0);
  frame.set(
    [
      sourcePort >>> 8,
      sourcePort & 0xff,
      0x23,
      0x28,
      udpLength >>> 8,
      udpLength & 0xff,
      (options.udpChecksum ?? 0) >>> 8,
      (options.udpChecksum ?? 0) & 0xff,
    ],
    34,
  );
  frame.set(data, 42);
  return frame;
}

test('Phase 25 guest UDP service exchanges deterministic Ethernet frames', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(
    '/bin/net25',
    buildUserExecutable(
      'net25',
      `
        #include "libc.h"
        int main(int argc, char **argv) {
          struct sockaddr_in local;
          struct sockaddr_in peer;
          struct pollfd watched;
          char buffer[16];
          int peer_length;
          int fd;
          int n;
          fd = socket(2, 2, 17);
          if (fd < 0) return 1;
          local.sin_family = 2;
          local.sin_port = htons(9000);
          local.sin_addr = htonl(0x0a00020f);
          if (bind(fd, &local, sizeof(struct sockaddr_in)) < 0) return 2;
          peer.sin_family = 2;
          peer.sin_port = htons(12345);
          peer.sin_addr = htonl(0x0a000202);
          if (connect(fd, &peer, sizeof(struct sockaddr_in)) < 0) return 6;
          watched.fd = fd;
          watched.events = 1;
          watched.revents = 0;
          if (poll(&watched, 1, -1) != 1) return 3;
          peer_length = sizeof(struct sockaddr_in);
          n = recvfrom(fd, buffer, 16, 0, &peer, &peer_length);
          if (n != 4 || memcmp(buffer, "ping", 4) != 0) return 4;
          if (sendto(fd, "pong", 4, 0, &peer, peer_length) != 4) return 5;
          write(1, "phase25-ok\\n", 11);
          return 0;
        }
      `,
    ),
  );
  fs.chmod('/bin/net25', 0o755);

  const kernel = buildGuestKernelImage();
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
  });
  machine.keyboard.feed('net25\n');
  machine.keyboard.close();
  machine.load(0, kernel.flat);
  machine.reset({ pc: kernel.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });

  assert.equal(machine.run(100_000_000).reason, 'halt');
  machine.network.inject(udpFrame('wrong', { sourceLast: 3 }));
  assert.equal(machine.run(20_000_000).reason, 'halt');
  assert.equal(output.includes('phase25-ok\n'), false, output);
  machine.network.inject(udpFrame('badlen', { udpLengthExtra: 4, padding: 4 }));
  assert.equal(machine.run(20_000_000).reason, 'halt');
  assert.equal(output.includes('phase25-ok\n'), false, output);
  machine.network.inject(udpFrame('badsum', { udpChecksum: 1 }));
  assert.equal(machine.run(20_000_000).reason, 'halt');
  assert.equal(output.includes('phase25-ok\n'), false, output);
  machine.network.inject(udpFrame('badip', { corruptIpChecksum: true }));
  assert.equal(machine.run(20_000_000).reason, 'halt');
  assert.equal(output.includes('phase25-ok\n'), false, output);
  machine.network.inject(udpFrame('fragment', { fragment: 0x2000 }));
  assert.equal(machine.run(20_000_000).reason, 'halt');
  assert.equal(output.includes('phase25-ok\n'), false, output);
  machine.network.inject(udpFrame('ping'));
  assert.equal(machine.run(100_000_000).reason, 'halt');

  const transmitted = machine.network.takeTransmitted();
  const udp = transmitted.find(
    (frame) => frame[12] === 0x08 && frame[13] === 0x00 && frame[23] === 17,
  );
  assert.ok(udp, 'guest did not transmit a UDP frame');
  assert.equal(new TextDecoder().decode(udp.subarray(42)), 'pong');
  assert.equal(output.includes('phase25-ok\n'), true, output);
  assert.equal(output.includes('PANIC'), false, output);
});

test('unknown IPv4 neighbors are resolved with ARP instead of broadcast IPv4', () => {
  const disk = buildGuestDiskImage();
  const ports = new PortBus();
  const blockDisk = new BlockDisk(disk);
  ports.register(PORT.DISK_DATA, 1, blockDisk);
  ports.register(PORT.DISK_POS, 1, blockDisk);
  ports.register(PORT.DISK_SECTORS, 1, blockDisk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(
    '/bin/arp25',
    buildUserExecutable(
      'arp25',
      `
        #include "libc.h"
        int main(int argc, char **argv) {
          struct sockaddr_in peer;
          int fd;
          fd = socket(2, 2, 17);
          if (fd < 0) return 1;
          peer.sin_family = 2;
          peer.sin_port = htons(9000);
          peer.sin_addr = htonl(0x0a000263);
          if (sendto(fd, "x", 1, 0, &peer, sizeof(struct sockaddr_in)) != -1 ||
              errno != 11) return 2;
          write(1, "arp25-ok\\n", 9);
          return 0;
        }
      `,
    ),
  );
  fs.chmod('/bin/arp25', 0o755);

  const kernel = buildGuestKernelImage();
  let output = '';
  const machine = new Machine({
    physSize: GUEST_KERNEL_LAYOUT.physSize,
    diskImage: disk,
    consoleSink: (text) => (output += text),
  });
  machine.keyboard.feed('arp25\n');
  machine.keyboard.close();
  machine.load(0, kernel.flat);
  machine.reset({ pc: kernel.entry, sp: GUEST_KERNEL_LAYOUT.kstackTop });
  assert.equal(machine.run(100_000_000).reason, 'halt');

  const transmitted = machine.network.takeTransmitted();
  assert.equal(
    transmitted.some((frame) => frame[12] === 0x08 && frame[13] === 0x00),
    false,
  );
  assert.equal(
    transmitted.some((frame) => frame[12] === 0x08 && frame[13] === 0x06),
    true,
  );
  assert.equal(output.includes('arp25-ok\n'), true, output);
});
