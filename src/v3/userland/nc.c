// nc: a minimal netcat for UDP. Relays stdin and a UDP socket so the guest can
// hold a two-way conversation with a peer (typically the host, reached through
// the gateway 10.0.2.2).
//
//   nc [-u] HOST PORT        connect to HOST:PORT and relay stdin <-> socket
//   nc [-u] -l [-p] PORT     listen on PORT, lock onto the first sender, relay
//
// -u is accepted for familiarity; UDP is the only supported mode.
#include "libc.h"

char io_buffer[512];

// Parse a dotted-quad IPv4 address into a host-order integer. Returns -1 on a
// malformed address.
int parse_ip(char *text, int *out) {
  int parts[4];
  int index;
  int value;
  int digits;
  int c;
  int i;
  index = 0;
  value = 0;
  digits = 0;
  i = 0;
  while (1) {
    c = text[i] & 255;
    if (c >= '0' && c <= '9') {
      value = value * 10 + (c - '0');
      if (value > 255) return -1;
      digits = digits + 1;
    } else if (c == '.' || c == 0) {
      if (digits == 0 || index >= 4) return -1;
      parts[index] = value;
      index = index + 1;
      value = 0;
      digits = 0;
      if (c == 0) break;
    } else {
      return -1;
    }
    i = i + 1;
  }
  if (index != 4) return -1;
  *out = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  return 0;
}

// Send a datagram, retrying while the kernel resolves the peer's hardware
// address (the first send to a new neighbour returns EAGAIN until ARP completes).
int send_dgram(int fd, char *buffer, int length, struct sockaddr_in *peer) {
  struct timespec delay;
  int tries;
  int n;
  delay.tv_sec = 0;
  delay.tv_nsec = 20000000;
  tries = 0;
  while (tries < 100) {
    n = sendto(fd, buffer, length, 0, peer, sizeof(struct sockaddr_in));
    if (n >= 0) return n;
    if (errno != CFG_EAGAIN) return n;
    nanosleep(&delay, 0);
    tries = tries + 1;
  }
  return -1;
}

void write_all(int fd, char *buffer, int length) {
  int off;
  int wrote;
  off = 0;
  while (off < length) {
    wrote = write(fd, buffer + off, length - off);
    if (wrote <= 0) return;
    off = off + wrote;
  }
}

// Pump bytes between stdin and the socket until either side closes. In listen
// mode the peer is unknown until the first datagram arrives; stdin is held back
// until then.
int relay(int fd, struct sockaddr_in *peer, int have_peer) {
  struct pollfd watched[2];
  int peer_length;
  int n;
  while (1) {
    watched[0].fd = 0;
    watched[0].events = CFG_POLLIN;
    watched[0].revents = 0;
    watched[1].fd = fd;
    watched[1].events = CFG_POLLIN;
    watched[1].revents = 0;
    if (poll(watched, 2, -1) < 0) {
      if (errno == CFG_EINTR) continue;
      return 1;
    }
    if ((watched[1].revents & CFG_POLLIN) != 0) {
      peer_length = sizeof(struct sockaddr_in);
      n = recvfrom(fd, io_buffer, 512, 0, peer, &peer_length);
      if (n < 0) {
        if (errno == CFG_EINTR || errno == CFG_EAGAIN) continue;
        return 1;
      }
      have_peer = 1;
      write_all(1, io_buffer, n);
    }
    if ((watched[0].revents & CFG_POLLIN) != 0) {
      n = read(0, io_buffer, 512);
      if (n == 0) return 0;
      if (n < 0) {
        if (errno == CFG_EINTR) continue;
        return 1;
      }
      if (have_peer != 0) {
        if (send_dgram(fd, io_buffer, n, peer) < 0) {
          write(2, "nc: send failed\n", 16);
          return 1;
        }
      }
    }
  }
}

void usage(void) {
  write(2, "usage: nc [-u] host port | nc [-u] -l [-p] port\n", 48);
}

int main(int argc, char **argv) {
  struct sockaddr_in local;
  struct sockaddr_in peer;
  char *host;
  int port;
  int listen_mode;
  int address;
  int fd;
  int i;
  listen_mode = 0;
  host = 0;
  port = 0;
  i = 1;
  while (i < argc) {
    if (strcmp(argv[i], "-l") == 0) {
      listen_mode = 1;
    } else if (strcmp(argv[i], "-u") == 0) {
      // UDP is implied; accepted for compatibility.
    } else if (strcmp(argv[i], "-p") == 0) {
      i = i + 1;
      if (i >= argc) {
        usage();
        return 1;
      }
      port = atoi(argv[i]);
    } else if (host == 0 && listen_mode == 0) {
      host = argv[i];
    } else {
      port = atoi(argv[i]);
    }
    i = i + 1;
  }
  if (port <= 0 || port > 65535) {
    usage();
    return 1;
  }
  if (listen_mode == 0 && host == 0) {
    usage();
    return 1;
  }

  fd = socket(CFG_AF_INET, CFG_SOCK_DGRAM, CFG_IPPROTO_UDP);
  if (fd < 0) {
    write(2, "nc: socket failed\n", 18);
    return 1;
  }

  if (listen_mode != 0) {
    local.sin_family = CFG_AF_INET;
    local.sin_port = htons(port);
    local.sin_addr = 0;
    if (bind(fd, &local, sizeof(struct sockaddr_in)) < 0) {
      write(2, "nc: bind failed\n", 16);
      return 1;
    }
    return relay(fd, &peer, 0);
  }

  if (parse_ip(host, &address) < 0) {
    write(2, "nc: invalid address (use a dotted IPv4 quad)\n", 45);
    return 1;
  }
  peer.sin_family = CFG_AF_INET;
  peer.sin_port = htons(port);
  peer.sin_addr = htonl(address);
  if (connect(fd, &peer, sizeof(struct sockaddr_in)) < 0) {
    write(2, "nc: connect failed\n", 19);
    return 1;
  }
  return relay(fd, &peer, 1);
}
