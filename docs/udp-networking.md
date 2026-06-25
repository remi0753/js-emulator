# Host ↔ guest UDP networking

**Concept:** the guest OS has a full Ethernet/ARP/IPv4/UDP stack in its kernel,
but on its own the virtual NIC's frames go nowhere. The boot tool attaches a
**host network bridge** that connects the NIC to the host's *real* UDP stack, so
a program on the host and a program inside the VM can hold a UDP conversation —
including with the guest's own `nc`.

```bash
# host terminal                # guest shell (inside the VM)
nc -u -l 4444                  nc 10.0.2.2 4444
```

Type on either side; each line crosses the bridge and appears on the other.

## The virtual network

The guest lives on a private virtual network, mirroring QEMU's user-mode
("slirp") defaults:

| role    | address     | MAC                 |
| ------- | ----------- | ------------------- |
| guest   | `10.0.2.15` | `02:00:00:00:00:02` |
| gateway | `10.0.2.2`  | `02:00:00:00:00:01` |

The guest's IP and MAC are fixed by the kernel
([`net_guest_ip`/`net_guest_mac`](../src/v3/kernel/network.c)); the gateway is
the bridge. As in QEMU, **the gateway address `10.0.2.2` is an alias for the
host loopback `127.0.0.1`**: from inside the VM you reach a host service
listening on the loopback by talking to `10.0.2.2`.

## How the bridge works

The bridge — [`src/vm/custom32/devices/net-bridge.ts`](../src/vm/custom32/devices/net-bridge.ts),
wired up in [`tools/boot.ts`](../tools/boot.ts) — hooks the NIC's `onTransmit`
(frames out of the guest) and `inject` (frames into the guest):

- **Proxy-ARP.** It answers *every* ARP request with the gateway MAC, so the
  guest resolves any destination to the gateway and routes all traffic through
  it. (The guest's first send to a new neighbour returns `EAGAIN` until this ARP
  round-trip completes; the guest `nc` retries automatically.)
- **Outbound NAT (guest → host).** It parses the guest's IPv4/UDP frames and
  re-sends the payload from a real host `dgram` socket. A datagram addressed to
  the gateway `10.0.2.2` is rewritten to `127.0.0.1`; replies are wrapped back
  into Ethernet/IP/UDP frames (source rewritten back to `10.0.2.2`) and injected
  into the NIC.
- **Inbound forwarding (host → guest).** Optional host-port forwards let a host
  client reach a service the guest is listening on. Each host client is mapped
  to a guest-facing source port on the gateway so the guest's replies route back
  to the right client.

The IP header checksum is always computed; the UDP checksum is sent as `0`
("absent"), which the guest's stack accepts.

## Using `nc` in the guest

The guest ships a minimal netcat ([`src/v3/userland/nc.c`](../src/v3/userland/nc.c)).
UDP is the only supported mode (the kernel stack is UDP-only), and hosts must be
given as dotted IPv4 quads (there is no DNS).

```
nc [-u] HOST PORT          connect to HOST:PORT, relay stdin <-> socket
nc [-u] -l [-p] PORT       listen on PORT, lock onto the first sender, relay
```

`-u` is accepted for familiarity and ignored. Internally `nc` `poll()`s stdin
and the socket together and copies bytes both ways until either side closes
(Ctrl-D on stdin, or EOF).

## Two ways to chat

### Guest connects to a host listener

The host service listens on the loopback; the guest reaches it via the gateway.

```bash
# host terminal
nc -u -l 4444
# guest shell
nc 10.0.2.2 4444
```

### Host connects to a guest listener

Forward a host port into the guest with the `JSCPU_HOSTFWD` environment variable
(`hostport:guestport`, comma-separate multiple entries):

```bash
# boot with a forward from host 5555 to guest 9000
JSCPU_HOSTFWD=5555:9000 npm run boot
# guest shell
nc -u -l -p 9000
# host terminal
nc -u 127.0.0.1 5555
```

## Tests

[`test/net-bridge.test.ts`](../test/net-bridge.test.ts) drives the bridge with a
real loopback UDP peer and asserts the three core behaviours: proxy-ARP, the
outbound NAT round-trip (guest → host → guest), and the inbound forward
round-trip (host → guest → host). The kernel-side UDP stack has its own
end-to-end coverage in
[`test/guest-network-phase25.test.ts`](../test/guest-network-phase25.test.ts).
