import dgram from 'node:dgram';

import type { NetworkCard } from './network.ts';

// A user-mode network bridge (QEMU "slirp" style) that connects the guest NIC
// to the host's real UDP stack. The guest lives on a private virtual network:
//
//   guest   10.0.2.15  (02:00:00:00:00:02)  — fixed by the kernel
//   gateway 10.0.2.2   (02:00:00:00:00:01)  — this bridge
//
// The bridge proxy-ARPs every address the guest asks about (so the guest can
// reach any destination through the gateway MAC), then NATs the guest's UDP
// datagrams onto real host sockets. As with QEMU, the gateway address 10.0.2.2
// is an alias for the host loopback (127.0.0.1): from inside the VM you reach a
// host service listening on the loopback by talking to 10.0.2.2.
//
//   host:  nc -u -l 4444
//   guest: nc 10.0.2.2 4444
//
// Optional host-forwarding entries make the reverse direction work too, so a
// host client can reach a service the guest is listening on:
//
//   guest: nc -u -l -p 9000
//   host:  nc -u 127.0.0.1 5555      (with hostfwd 5555 -> 9000)

const GUEST_IP = 0x0a00020f; // 10.0.2.15
const GATEWAY_IP = 0x0a000202; // 10.0.2.2
const LOOPBACK_IP = 0x7f000001; // 127.0.0.1
const GUEST_MAC = [0x02, 0x00, 0x00, 0x00, 0x00, 0x02];
const GATEWAY_MAC = [0x02, 0x00, 0x00, 0x00, 0x00, 0x01];

const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_ARP = 0x0806;
const IPPROTO_UDP = 17;

export interface HostForward {
  hostPort: number;
  guestPort: number;
}

export interface NetBridgeOptions {
  // Called after a frame is injected into the NIC so the embedding run loop can
  // re-schedule the guest (the injection happens asynchronously from host I/O).
  onActivity?: () => void;
  // Host UDP ports to forward into the guest.
  hostfwd?: HostForward[];
  log?: (message: string) => void;
}

interface OutboundFlow {
  socket: dgram.Socket;
  guestPort: number; // guest's UDP source port
  peerIp: number; // destination as the guest addressed it (for reply src)
  peerPort: number;
}

interface InboundClient {
  natPort: number; // guest-facing source port on the gateway
  address: string; // real host client address
  port: number; // real host client port
  guestPort: number; // guest service port this client is talking to
  socket: dgram.Socket; // host listen socket to reply through
}

function ipToString(ip: number): string {
  return `${(ip >>> 24) & 255}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`;
}

function read16(frame: Uint8Array, offset: number): number {
  return ((frame[offset]! << 8) | frame[offset + 1]!) & 0xffff;
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

function write16(frame: Uint8Array, offset: number, value: number): void {
  frame[offset] = (value >>> 8) & 0xff;
  frame[offset + 1] = value & 0xff;
}

function write32(frame: Uint8Array, offset: number, value: number): void {
  frame[offset] = (value >>> 24) & 0xff;
  frame[offset + 1] = (value >>> 16) & 0xff;
  frame[offset + 2] = (value >>> 8) & 0xff;
  frame[offset + 3] = value & 0xff;
}

function checksum(frame: Uint8Array, start: number, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i += 2) {
    let word = frame[start + i]! << 8;
    if (i + 1 < length) word |= frame[start + i + 1]!;
    sum += word;
    while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  }
  return ~sum & 0xffff;
}

export class NetBridge {
  private readonly nic: NetworkCard;
  private readonly onActivity: () => void;
  private readonly log: (message: string) => void;
  private readonly outbound = new Map<string, OutboundFlow>();
  private readonly hostSockets: dgram.Socket[] = [];
  // Guest-facing NAT ports allocated for inbound (hostfwd) clients.
  private readonly inbound = new Map<number, InboundClient>();
  private nextNatPort = 40000;
  private closed = false;

  constructor(nic: NetworkCard, options: NetBridgeOptions = {}) {
    this.nic = nic;
    this.onActivity = options.onActivity ?? (() => {});
    this.log = options.log ?? (() => {});
    this.nic.onTransmit = (frame) => this.handleGuestFrame(frame);
    for (const forward of options.hostfwd ?? []) this.openHostForward(forward);
  }

  close(): void {
    this.closed = true;
    for (const flow of this.outbound.values()) flow.socket.close();
    this.outbound.clear();
    for (const socket of this.hostSockets) socket.close();
    this.hostSockets.length = 0;
  }

  // --- guest -> host -------------------------------------------------------

  private handleGuestFrame(frame: Uint8Array): void {
    if (this.closed || frame.length < 14) return;
    const ethertype = read16(frame, 12);
    if (ethertype === ETHERTYPE_ARP) this.handleArp(frame);
    else if (ethertype === ETHERTYPE_IPV4) this.handleIpv4(frame);
  }

  private handleArp(frame: Uint8Array): void {
    if (frame.length < 42) return;
    if (read16(frame, 14) !== 1 || read16(frame, 16) !== ETHERTYPE_IPV4) return;
    if (read16(frame, 20) !== 1) return; // only answer requests
    const targetIp = read32(frame, 38);
    // Proxy-ARP: claim every address so the guest routes everything to us.
    const reply = new Uint8Array(42);
    for (let i = 0; i < 6; i++) {
      reply[i] = frame[22 + i]!; // dst = original sender's MAC
      reply[6 + i] = GATEWAY_MAC[i]!;
    }
    write16(reply, 12, ETHERTYPE_ARP);
    write16(reply, 14, 1); // htype ethernet
    write16(reply, 16, ETHERTYPE_IPV4); // ptype IPv4
    reply[18] = 6;
    reply[19] = 4;
    write16(reply, 20, 2); // oper = reply
    for (let i = 0; i < 6; i++) reply[22 + i] = GATEWAY_MAC[i]!;
    write32(reply, 28, targetIp); // sender IP = the address asked about
    for (let i = 0; i < 6; i++) reply[32 + i] = frame[22 + i]!;
    write32(reply, 38, read32(frame, 28)); // target IP = guest
    this.injectFrame(reply);
  }

  private handleIpv4(frame: Uint8Array): void {
    if (frame.length < 34) return;
    if ((frame[14]! & 0xf0) !== 0x40) return; // IPv4 only
    const ihl = (frame[14]! & 0x0f) * 4;
    if (ihl < 20 || frame.length < 14 + ihl + 8) return;
    if (frame[23] !== IPPROTO_UDP) return;
    const udp = 14 + ihl;
    const sourcePort = read16(frame, udp);
    const destPort = read16(frame, udp + 2);
    const udpLength = read16(frame, udp + 4);
    const destIp = read32(frame, 30);
    const payloadLength = udpLength - 8;
    if (payloadLength < 0 || udp + 8 + payloadLength > frame.length) return;
    const payload = Buffer.from(frame.subarray(udp + 8, udp + 8 + payloadLength));

    // A reply from the guest back to a hostfwd client?
    if (destIp === GATEWAY_IP) {
      const client = this.inbound.get(destPort);
      if (client) {
        client.socket.send(payload, client.port, client.address);
        return;
      }
    }

    // Otherwise NAT the datagram out onto a real host socket.
    const realIp = destIp === GATEWAY_IP ? LOOPBACK_IP : destIp;
    this.sendOutbound(sourcePort, destIp, destPort, realIp, payload);
  }

  private sendOutbound(
    guestPort: number,
    peerIp: number,
    peerPort: number,
    realIp: number,
    payload: Buffer,
  ): void {
    const key = `${guestPort}:${peerIp}:${peerPort}`;
    let flow = this.outbound.get(key);
    if (!flow) {
      const socket = dgram.createSocket('udp4');
      socket.on('error', () => {});
      flow = { socket, guestPort, peerIp, peerPort };
      socket.on('message', (message) => this.deliverToGuest(flow!, message));
      this.outbound.set(key, flow);
      this.log(
        `[net] guest :${guestPort} -> ${ipToString(peerIp)}:${peerPort} (via ${ipToString(realIp)})`,
      );
    }
    flow.socket.send(payload, peerPort, ipToString(realIp));
  }

  // --- host -> guest -------------------------------------------------------

  private deliverToGuest(flow: OutboundFlow, payload: Buffer): void {
    // Reply appears to come from the address/port the guest originally used.
    this.injectUdp(flow.peerIp, flow.peerPort, flow.guestPort, payload);
  }

  private openHostForward(forward: HostForward): void {
    const socket = dgram.createSocket('udp4');
    socket.on('error', (error) => this.log(`[net] hostfwd ${forward.hostPort}: ${error.message}`));
    socket.on('message', (message, rinfo) => {
      const natPort = this.natPortFor(forward, socket, rinfo.address, rinfo.port);
      this.injectUdp(GATEWAY_IP, natPort, forward.guestPort, Buffer.from(message));
    });
    socket.bind(forward.hostPort, () => {
      this.log(`[net] hostfwd 127.0.0.1:${forward.hostPort} -> guest :${forward.guestPort}`);
    });
    this.hostSockets.push(socket);
  }

  private natPortFor(
    forward: HostForward,
    socket: dgram.Socket,
    address: string,
    port: number,
  ): number {
    for (const [natPort, client] of this.inbound) {
      if (
        client.address === address &&
        client.port === port &&
        client.guestPort === forward.guestPort
      ) {
        return natPort;
      }
    }
    const natPort = this.nextNatPort++;
    if (this.nextNatPort > 60000) this.nextNatPort = 40000;
    this.inbound.set(natPort, {
      natPort,
      address,
      port,
      guestPort: forward.guestPort,
      socket,
    });
    return natPort;
  }

  private injectUdp(sourceIp: number, sourcePort: number, destPort: number, payload: Buffer): void {
    const total = 20 + 8 + payload.length;
    const frame = new Uint8Array(14 + total);
    for (let i = 0; i < 6; i++) {
      frame[i] = GUEST_MAC[i]!;
      frame[6 + i] = GATEWAY_MAC[i]!;
    }
    write16(frame, 12, ETHERTYPE_IPV4);
    frame[14] = 0x45; // version 4, IHL 5
    frame[15] = 0;
    write16(frame, 16, total);
    write16(frame, 18, 0);
    write16(frame, 20, 0);
    frame[22] = 64; // TTL
    frame[23] = IPPROTO_UDP;
    write16(frame, 24, 0);
    write32(frame, 26, sourceIp);
    write32(frame, 30, GUEST_IP);
    write16(frame, 24, checksum(frame, 14, 20));
    write16(frame, 34, sourcePort);
    write16(frame, 36, destPort);
    write16(frame, 38, 8 + payload.length);
    write16(frame, 40, 0); // UDP checksum 0: the guest treats this as "absent"
    frame.set(payload, 42);
    this.injectFrame(frame);
  }

  private injectFrame(frame: Uint8Array): void {
    if (this.closed) return;
    try {
      this.nic.inject(frame);
    } catch {
      return;
    }
    this.onActivity();
  }
}

export { ipToString };
