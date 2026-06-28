import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { test } from 'node:test';

import { NetBridge } from '../src/vm/custom32/devices/net-bridge.ts';
import { NetworkCard } from '../src/vm/custom32/devices/network.ts';

const PORTS = { status: 0, rxLength: 1, rxData: 2, txLength: 3, txData: 4 };
const GUEST_IP = 0x0a00020f;
const GATEWAY_IP = 0x0a000202;

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    sum += (bytes[i]! << 8) | (bytes[i + 1] ?? 0);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return ~sum & 0xffff;
}

// Feed a frame to the NIC the way the guest would: write TX_LEN, then the bytes.
function guestTransmit(nic: NetworkCard, frame: Uint8Array): void {
  nic.write(PORTS.txLength, frame.length);
  for (const byte of frame) nic.write(PORTS.txData, byte);
}

// Read one frame out of the NIC the way the guest's RX path would.
function guestReceive(nic: NetworkCard): Uint8Array | null {
  if (nic.read(PORTS.status) !== 1) return null;
  const length = nic.read(PORTS.rxLength);
  const frame = new Uint8Array(length);
  for (let i = 0; i < length; i++) frame[i] = nic.read(PORTS.rxData);
  return frame;
}

function read16(frame: Uint8Array, offset: number): number {
  return (frame[offset]! << 8) | frame[offset + 1]!;
}

// Poll the NIC until a frame matching the predicate is injected. The interval is
// cleared on *both* the resolve and reject paths — leaving it running keeps the
// event loop alive and makes the whole test process hang after a timeout.
// `onTick` runs every poll so callers can retry lossy host I/O (e.g. UDP sends)
// until the bridge has finished binding.
function waitForFrame(
  nic: NetworkCard,
  predicate: (frame: Uint8Array) => boolean = () => true,
  onTick: () => void = () => {},
  timeoutMs = 2000,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      clearInterval(poll);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('no matching frame injected'))),
      timeoutMs,
    );
    const poll = setInterval(() => {
      const frame = guestReceive(nic);
      if (frame && predicate(frame)) finish(() => resolve(frame));
      else onTick();
    }, 5);
  });
}

function read32(frame: Uint8Array, offset: number): number {
  return (
    ((frame[offset]! << 24) |
      (frame[offset + 1]! << 16) |
      (frame[offset + 2]! << 8) |
      frame[offset + 3]!) >>>
    0
  );
}

function arpRequest(targetIp: number): Uint8Array {
  const frame = new Uint8Array(42);
  frame.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02, 0, 0, 0, 0, 2, 0x08, 0x06]);
  frame.set([0, 1, 0x08, 0x00, 6, 4, 0, 1], 14); // htype/ptype/hlen/plen/oper(request)
  frame.set([0x02, 0, 0, 0, 0, 2], 22); // sender MAC = guest
  frame[28] = (GUEST_IP >>> 24) & 0xff;
  frame[29] = (GUEST_IP >>> 16) & 0xff;
  frame[30] = (GUEST_IP >>> 8) & 0xff;
  frame[31] = GUEST_IP & 0xff;
  frame[38] = (targetIp >>> 24) & 0xff;
  frame[39] = (targetIp >>> 16) & 0xff;
  frame[40] = (targetIp >>> 8) & 0xff;
  frame[41] = targetIp & 0xff;
  return frame;
}

function udpFrame(srcPort: number, dstIp: number, dstPort: number, payload: string): Uint8Array {
  const data = new TextEncoder().encode(payload);
  const frame = new Uint8Array(14 + 20 + 8 + data.length);
  frame.set([0x02, 0, 0, 0, 0, 1, 0x02, 0, 0, 0, 0, 2, 0x08, 0x00]); // to gateway MAC, from guest
  frame.set([0x45, 0, 0, 28 + data.length, 0, 1, 0, 0, 64, 17, 0, 0], 14);
  frame[26] = (GUEST_IP >>> 24) & 0xff;
  frame[27] = (GUEST_IP >>> 16) & 0xff;
  frame[28] = (GUEST_IP >>> 8) & 0xff;
  frame[29] = GUEST_IP & 0xff;
  frame[30] = (dstIp >>> 24) & 0xff;
  frame[31] = (dstIp >>> 16) & 0xff;
  frame[32] = (dstIp >>> 8) & 0xff;
  frame[33] = dstIp & 0xff;
  const ip = checksum(frame.subarray(14, 34));
  frame[24] = ip >>> 8;
  frame[25] = ip & 0xff;
  frame.set(
    [
      srcPort >>> 8,
      srcPort & 0xff,
      dstPort >>> 8,
      dstPort & 0xff,
      (8 + data.length) >>> 8,
      (8 + data.length) & 0xff,
      0,
      0,
    ],
    34,
  );
  frame.set(data, 42);
  return frame;
}

test('bridge proxy-ARPs every address the guest queries', () => {
  const nic = new NetworkCard(PORTS);
  const bridge = new NetBridge(nic);
  try {
    guestTransmit(nic, arpRequest(GATEWAY_IP));
    const reply = guestReceive(nic);
    assert.ok(reply, 'no ARP reply injected');
    assert.equal(read16(reply, 12), 0x0806); // ARP
    assert.equal(read16(reply, 20), 2); // reply opcode
    assert.deepEqual([...reply.subarray(22, 28)], [0x02, 0, 0, 0, 0, 1]); // gateway MAC
    assert.equal(read32(reply, 28), GATEWAY_IP); // sender protocol address
    assert.equal(read32(reply, 38), GUEST_IP); // target = guest
  } finally {
    bridge.close();
  }
});

test('bridge NATs guest UDP to the host loopback and injects the reply', async () => {
  const server = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
  const serverPort = (server.address() as { port: number }).port;

  const nic = new NetworkCard(PORTS);
  let activity = 0;
  const bridge = new NetBridge(nic, { onActivity: () => activity++ });

  try {
    // The host server echoes a tagged reply back to whoever sent to it.
    const received = new Promise<string>((resolve) => {
      server.on('message', (message, rinfo) => {
        server.send(`reply:${message.toString()}`, rinfo.port, rinfo.address);
        resolve(message.toString());
      });
    });

    // Guest sends to the gateway 10.0.2.2, which the bridge maps to 127.0.0.1.
    guestTransmit(nic, udpFrame(49152, GATEWAY_IP, serverPort, 'ping'));
    assert.equal(await received, 'ping');

    // The reply should be injected back as a frame addressed to the guest,
    // appearing to come from the gateway address/port the guest used.
    const reply = await waitForFrame(nic);

    assert.equal(read16(reply, 12), 0x0800); // IPv4
    assert.equal(reply[23], 17); // UDP
    assert.equal(read32(reply, 26), GATEWAY_IP); // source rewritten back to gateway
    assert.equal(read32(reply, 30), GUEST_IP); // destined for the guest
    assert.equal(read16(reply, 34), serverPort); // source port = the port guest addressed
    assert.equal(read16(reply, 36), 49152); // destined to the guest's source port
    assert.equal(new TextDecoder().decode(reply.subarray(42)), 'reply:ping');
    assert.ok(activity > 0, 'onActivity was never invoked');
  } finally {
    bridge.close();
    server.close();
  }
});

test('hostfwd delivers a host datagram into the guest and routes the reply back', async () => {
  // Reserve a free port, release it, then forward it into the guest.
  const reserve = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => reserve.bind(0, '127.0.0.1', resolve));
  const hostPort = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(resolve));

  const nic = new NetworkCard(PORTS);
  const bridge = new NetBridge(nic, { hostfwd: [{ hostPort, guestPort: 9100 }] });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the forward bind

  const client = dgram.createSocket('udp4');
  try {
    const reply = new Promise<string>((resolve) => {
      client.on('message', (message) => resolve(message.toString()));
    });
    await new Promise<void>((resolve) => client.bind(0, '127.0.0.1', resolve));

    // The guest receives the datagram as a frame from the gateway. Resend the
    // datagram on every poll: it travels over a real host UDP socket and the
    // first ones can race the bridge's asynchronous hostfwd bind (or be dropped).
    const inFrame = await waitForFrame(
      nic,
      (frame) => read16(frame, 12) === 0x0800,
      () => client.send('knock', hostPort, '127.0.0.1'),
    );
    assert.equal(read32(inFrame, 26), GATEWAY_IP);
    assert.equal(read32(inFrame, 30), GUEST_IP);
    assert.equal(read16(inFrame, 36), 9100);
    assert.equal(new TextDecoder().decode(inFrame.subarray(42)), 'knock');

    // The guest replies to the gateway:natPort; the bridge routes it to the client.
    const natPort = read16(inFrame, 34);
    guestTransmit(nic, udpFrame(9100, GATEWAY_IP, natPort, 'who'));
    assert.equal(await reply, 'who');
  } finally {
    bridge.close();
    client.close();
  }
});
