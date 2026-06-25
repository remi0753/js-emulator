// Socket layer plus a compact Ethernet/ARP/IPv4/ICMP/UDP stack.
#include "kernel.h"

struct socket socket_table[CFG_NSOCKET];
char net_tx_frame[1518];
int net_ephemeral_port;

int net_read16(char *p) {
  return ((p[0] & 255) << 8) | (p[1] & 255);
}

int net_read32(char *p) {
  return ((p[0] & 255) << 24) | ((p[1] & 255) << 16) |
    ((p[2] & 255) << 8) | (p[3] & 255);
}

void net_write16(char *p, int value) {
  p[0] = (value >> 8) & 255;
  p[1] = value & 255;
}

void net_write32(char *p, int value) {
  p[0] = (value >> 24) & 255;
  p[1] = (value >> 16) & 255;
  p[2] = (value >> 8) & 255;
  p[3] = value & 255;
}

int net_checksum(char *p, int length) {
  int sum;
  int i;
  int word;
  sum = 0;
  i = 0;
  while (i < length) {
    word = (p[i] & 255) << 8;
    if (i + 1 < length) word = word | (p[i + 1] & 255);
    sum = sum + word;
    while ((sum >> 16) != 0) sum = (sum & 65535) + (sum >> 16);
    i = i + 2;
  }
  return (~sum) & 65535;
}

void net_guest_mac(char *p) {
  p[0] = 2; p[1] = 0; p[2] = 0; p[3] = 0; p[4] = 0; p[5] = 2;
}

int net_guest_ip(void) {
  return 0x0a00020f;
}

void net_transmit(char *frame, int length) {
  int i;
  __out(CFG_NET_TX_LEN, length);
  i = 0;
  while (i < length) {
    __out(CFG_NET_TX_DATA, frame[i] & 255);
    i = i + 1;
  }
}

void net_reply_arp(char *frame, int length) {
  int i;
  if (length < 42 || net_read16(frame + 20) != 1 ||
      net_read32(frame + 38) != net_guest_ip()) return;
  i = 0;
  while (i < 6) {
    net_tx_frame[i] = frame[22 + i];
    i = i + 1;
  }
  net_guest_mac(net_tx_frame + 6);
  net_write16(net_tx_frame + 12, 0x0806);
  net_write16(net_tx_frame + 14, 1);
  net_write16(net_tx_frame + 16, 0x0800);
  net_tx_frame[18] = 6;
  net_tx_frame[19] = 4;
  net_write16(net_tx_frame + 20, 2);
  net_guest_mac(net_tx_frame + 22);
  net_write32(net_tx_frame + 28, net_guest_ip());
  i = 0;
  while (i < 6) {
    net_tx_frame[32 + i] = frame[22 + i];
    i = i + 1;
  }
  net_write32(net_tx_frame + 38, net_read32(frame + 28));
  net_transmit(net_tx_frame, 42);
}

void net_reply_icmp(char *frame, int length, int ihl, int total) {
  int i;
  int sum;
  int icmp_length;
  if (length < 14 + total || frame[14 + ihl] != 8) return;
  i = 0;
  while (i < 6) {
    net_tx_frame[i] = frame[6 + i];
    net_tx_frame[6 + i] = frame[i];
    i = i + 1;
  }
  i = 12;
  while (i < 14 + total) {
    net_tx_frame[i] = frame[i];
    i = i + 1;
  }
  net_write32(net_tx_frame + 26, net_read32(frame + 30));
  net_write32(net_tx_frame + 30, net_guest_ip());
  net_tx_frame[24] = 0;
  net_tx_frame[25] = 0;
  sum = net_checksum(net_tx_frame + 14, ihl);
  net_write16(net_tx_frame + 24, sum);
  net_tx_frame[14 + ihl] = 0;
  net_tx_frame[14 + ihl + 2] = 0;
  net_tx_frame[14 + ihl + 3] = 0;
  icmp_length = total - ihl;
  sum = net_checksum(net_tx_frame + 14 + ihl, icmp_length);
  net_write16(net_tx_frame + 14 + ihl + 2, sum);
  net_transmit(net_tx_frame, 14 + total);
}

void net_receive_udp(char *frame, int length, int ihl, int total) {
  struct socket *socket;
  struct udp_datagram *datagram;
  int udp;
  int destination_port;
  int payload_length;
  int i;
  int s;
  udp = 14 + ihl;
  if (length < udp + 8 || total < ihl + 8) return;
  destination_port = net_read16(frame + udp + 2);
  payload_length = net_read16(frame + udp + 4) - 8;
  if (payload_length < 0 || payload_length > 512 ||
      udp + 8 + payload_length > length) return;
  s = 0;
  while (s < CFG_NSOCKET) {
    socket = &socket_table[s];
    if (socket->used != 0 && socket->type == CFG_SOCK_DGRAM &&
        socket->local_port == destination_port) {
      if (socket->queue_count >= 4) return;
      datagram = &socket->queue[
        (socket->queue_head + socket->queue_count) % 4];
      datagram->length = payload_length;
      datagram->source_address = net_read32(frame + 26);
      datagram->source_port = net_read16(frame + udp);
      i = 0;
      while (i < payload_length) {
        datagram->data[i] = frame[udp + 8 + i];
        i = i + 1;
      }
      socket->queue_count = socket->queue_count + 1;
      socket->remote_address = datagram->source_address;
      socket->remote_port = datagram->source_port;
      i = 0;
      while (i < 6) {
        socket->remote_mac[i] = frame[6 + i];
        i = i + 1;
      }
      wakeup(socket);
      poll_wakeup();
      return;
    }
    s = s + 1;
  }
}

void net_receive_frame(char *frame, int length) {
  int ethertype;
  int ihl;
  int total;
  int protocol;
  if (length < 14) return;
  ethertype = net_read16(frame + 12);
  if (ethertype == 0x0806) {
    net_reply_arp(frame, length);
    return;
  }
  if (ethertype != 0x0800 || length < 34 ||
      (frame[14] & 240) != 64 ||
      net_read32(frame + 30) != net_guest_ip()) return;
  ihl = (frame[14] & 15) * 4;
  total = net_read16(frame + 16);
  if (ihl < 20 || total < ihl || 14 + total > length) return;
  protocol = frame[23] & 255;
  if (protocol == 1) net_reply_icmp(frame, length, ihl, total);
  else if (protocol == CFG_IPPROTO_UDP) {
    net_receive_udp(frame, length, ihl, total);
  }
}

int socket_index_from_fd(int caller, int fd) {
  if (fd < 0 || fd >= CFG_NFD ||
      proc_table[caller].files[fd].type != CFG_FT_SOCKET) {
    return -1;
  }
  return proc_table[caller].files[fd].object;
}

void network_init(void) {
  int i;
  i = 0;
  while (i < CFG_NSOCKET) {
    socket_table[i].used = 0;
    i = i + 1;
  }
  net_ephemeral_port = 49152;
}

int socket_create(int caller, int domain, int type, int protocol) {
  int fd;
  int s;
  if (domain != CFG_AF_INET) return -CFG_EAFNOSUPPORT;
  if (type == CFG_SOCK_STREAM) return -CFG_EPROTONOSUPPORT;
  if (type != CFG_SOCK_DGRAM) return -CFG_EPROTONOSUPPORT;
  if (protocol != 0 && protocol != CFG_IPPROTO_UDP) {
    return -CFG_EPROTONOSUPPORT;
  }
  s = 0;
  while (s < CFG_NSOCKET && socket_table[s].used != 0) s = s + 1;
  if (s == CFG_NSOCKET) return -CFG_ENFILE;
  fd = alloc_fd(caller);
  if (fd < 0) return -CFG_EMFILE;
  memset(&socket_table[s], 0, sizeof(struct socket));
  socket_table[s].used = 1;
  socket_table[s].refs = 1;
  socket_table[s].type = type;
  socket_table[s].protocol = CFG_IPPROTO_UDP;
  file_set_socket(&proc_table[caller].files[fd], s);
  return fd;
}

int socket_copy_address(
  int caller, int address, int length, struct guest_sockaddr_in *value
) {
  if (length < sizeof(struct guest_sockaddr_in)) return -CFG_EINVAL;
  if (copyin(caller, value, address,
      sizeof(struct guest_sockaddr_in)) < 0) return -CFG_EFAULT;
  if (value->family != CFG_AF_INET) return -CFG_EAFNOSUPPORT;
  value->port = ((value->port & 255) << 8) |
    ((value->port >> 8) & 255);
  value->address =
    ((value->address & 255) << 24) |
    ((value->address & 0xff00) << 8) |
    ((value->address >> 8) & 0xff00) |
    ((value->address >> 24) & 255);
  return 0;
}

int socket_bind(int caller, int fd, int address, int length) {
  struct guest_sockaddr_in value;
  int s;
  int i;
  int result;
  s = socket_index_from_fd(caller, fd);
  if (s < 0) return -CFG_ENOTSOCK;
  result = socket_copy_address(caller, address, length, &value);
  if (result < 0) return result;
  if (value.port <= 0 || value.port > 65535) return -CFG_EINVAL;
  i = 0;
  while (i < CFG_NSOCKET) {
    if (i != s && socket_table[i].used != 0 &&
        socket_table[i].local_port == value.port) return -CFG_EADDRINUSE;
    i = i + 1;
  }
  socket_table[s].local_port = value.port;
  return 0;
}

int socket_connect(int caller, int fd, int address, int length) {
  struct guest_sockaddr_in value;
  int s;
  int result;
  s = socket_index_from_fd(caller, fd);
  if (s < 0) return -CFG_ENOTSOCK;
  result = socket_copy_address(caller, address, length, &value);
  if (result < 0) return result;
  socket_table[s].remote_address = value.address;
  socket_table[s].remote_port = value.port;
  return 0;
}

int socket_listen(int caller, int fd, int backlog) {
  if (socket_index_from_fd(caller, fd) < 0) return -CFG_ENOTSOCK;
  return -CFG_EOPNOTSUPP;
}

int socket_accept(int caller, int fd, int address, int length) {
  if (socket_index_from_fd(caller, fd) < 0) return -CFG_ENOTSOCK;
  return -CFG_EOPNOTSUPP;
}

int socket_setsockopt(int caller, int fd, int args) {
  if (socket_index_from_fd(caller, fd) < 0) return -CFG_ENOTSOCK;
  return 0;
}

int socket_allocate_port(int socket) {
  int candidate;
  int i;
  int used;
  if (socket_table[socket].local_port != 0) {
    return socket_table[socket].local_port;
  }
  while (net_ephemeral_port < 65535) {
    candidate = net_ephemeral_port;
    net_ephemeral_port = net_ephemeral_port + 1;
    used = 0;
    i = 0;
    while (i < CFG_NSOCKET) {
      if (socket_table[i].used != 0 &&
          socket_table[i].local_port == candidate) used = 1;
      i = i + 1;
    }
    if (used == 0) {
      socket_table[socket].local_port = candidate;
      return candidate;
    }
  }
  return -CFG_EADDRINUSE;
}

int socket_send_destination(
  int caller, int socket_index, int buffer, int length,
  int address, int port
) {
  struct socket *socket;
  int i;
  int ip_sum;
  int source_port;
  int frame_length;
  if (length < 0) return -CFG_EINVAL;
  if (length > 512) return -CFG_EMSGSIZE;
  if (user_access_ok(caller, buffer, length, 0) == 0) return -CFG_EFAULT;
  if (address == 0 || port == 0) return -CFG_EDESTADDRREQ;
  source_port = socket_allocate_port(socket_index);
  if (source_port < 0) return source_port;
  socket = &socket_table[socket_index];
  i = 0;
  while (i < 6) {
    if (socket->remote_mac[0] == 0 && socket->remote_mac[1] == 0) {
      net_tx_frame[i] = 255;
    } else {
      net_tx_frame[i] = socket->remote_mac[i];
    }
    i = i + 1;
  }
  net_guest_mac(net_tx_frame + 6);
  net_write16(net_tx_frame + 12, 0x0800);
  net_tx_frame[14] = 0x45;
  net_tx_frame[15] = 0;
  net_write16(net_tx_frame + 16, 20 + 8 + length);
  net_write16(net_tx_frame + 18, 0);
  net_write16(net_tx_frame + 20, 0);
  net_tx_frame[22] = 64;
  net_tx_frame[23] = CFG_IPPROTO_UDP;
  net_write16(net_tx_frame + 24, 0);
  net_write32(net_tx_frame + 26, net_guest_ip());
  net_write32(net_tx_frame + 30, address);
  ip_sum = net_checksum(net_tx_frame + 14, 20);
  net_write16(net_tx_frame + 24, ip_sum);
  net_write16(net_tx_frame + 34, source_port);
  net_write16(net_tx_frame + 36, port);
  net_write16(net_tx_frame + 38, 8 + length);
  net_write16(net_tx_frame + 40, 0);
  if (copyin(caller, net_tx_frame + 42, buffer, length) < 0) {
    return -CFG_EFAULT;
  }
  frame_length = 42 + length;
  net_transmit(net_tx_frame, frame_length);
  return length;
}

int socket_send_object(int caller, int socket, int buffer, int length) {
  if (socket < 0 || socket >= CFG_NSOCKET ||
      socket_table[socket].used == 0) return -CFG_ENOTSOCK;
  return socket_send_destination(caller, socket, buffer, length,
    socket_table[socket].remote_address,
    socket_table[socket].remote_port);
}

int socket_send(int caller, int fd, int buffer, int length) {
  int s;
  s = socket_index_from_fd(caller, fd);
  if (s < 0) return -CFG_ENOTSOCK;
  return socket_send_object(caller, s, buffer, length);
}

int socket_receive_datagram(
  int caller, int socket_index, int buffer, int length,
  int address, int address_length
) {
  struct socket *socket;
  struct udp_datagram *datagram;
  struct guest_sockaddr_in peer;
  int peer_length;
  int n;
  if (length < 0) return -CFG_EINVAL;
  if (user_access_ok(caller, buffer, length, 1) == 0) return -CFG_EFAULT;
  socket = &socket_table[socket_index];
  if (socket->queue_count == 0) {
    g_noret = 1;
    proc_table[caller].ctx.pc =
      proc_table[caller].ctx.pc - CFG_SYSCALL_INSTR_SIZE;
    sleep(caller, socket);
    return 0;
  }
  datagram = &socket->queue[socket->queue_head];
  n = datagram->length;
  if (n > length) n = length;
  if (copyout(caller, buffer, datagram->data, n) < 0) return -CFG_EFAULT;
  if (address != 0 && address_length != 0) {
    if (copyin(caller, &peer_length, address_length, 4) < 0) {
      return -CFG_EFAULT;
    }
    if (peer_length >= sizeof(struct guest_sockaddr_in)) {
      peer.family = CFG_AF_INET;
      peer.port = ((datagram->source_port & 255) << 8) |
        ((datagram->source_port >> 8) & 255);
      peer.address =
        ((datagram->source_address & 255) << 24) |
        ((datagram->source_address & 0xff00) << 8) |
        ((datagram->source_address >> 8) & 0xff00) |
        ((datagram->source_address >> 24) & 255);
      if (copyout(caller, address, &peer,
          sizeof(struct guest_sockaddr_in)) < 0) return -CFG_EFAULT;
      peer_length = sizeof(struct guest_sockaddr_in);
      if (copyout(caller, address_length, &peer_length, 4) < 0) {
        return -CFG_EFAULT;
      }
    }
  }
  socket->queue_head = (socket->queue_head + 1) % 4;
  socket->queue_count = socket->queue_count - 1;
  poll_wakeup();
  return n;
}

int socket_recv_object(int caller, int socket, int buffer, int length) {
  if (socket < 0 || socket >= CFG_NSOCKET ||
      socket_table[socket].used == 0) return -CFG_ENOTSOCK;
  return socket_receive_datagram(caller, socket, buffer, length, 0, 0);
}

int socket_recv(int caller, int fd, int buffer, int length) {
  int s;
  s = socket_index_from_fd(caller, fd);
  if (s < 0) return -CFG_ENOTSOCK;
  if ((proc_table[caller].files[fd].status_flags & CFG_O_NONBLOCK) != 0 &&
      socket_table[s].queue_count == 0) return -CFG_EAGAIN;
  return socket_recv_object(caller, s, buffer, length);
}

int socket_sendto(int caller, int fd, int args) {
  int values[5];
  struct guest_sockaddr_in address;
  int s;
  int result;
  s = socket_index_from_fd(caller, fd);
  if (s < 0) return -CFG_ENOTSOCK;
  if (copyin(caller, values, args, 20) < 0) return -CFG_EFAULT;
  if (values[2] != 0) return -CFG_EOPNOTSUPP;
  result = socket_copy_address(caller, values[3], values[4], &address);
  if (result < 0) return result;
  return socket_send_destination(caller, s, values[0], values[1],
    address.address, address.port);
}

int socket_recvfrom(int caller, int fd, int args) {
  int values[5];
  int s;
  s = socket_index_from_fd(caller, fd);
  if (s < 0) return -CFG_ENOTSOCK;
  if (copyin(caller, values, args, 20) < 0) return -CFG_EFAULT;
  if (values[2] != 0) return -CFG_EOPNOTSUPP;
  if ((proc_table[caller].files[fd].status_flags & CFG_O_NONBLOCK) != 0 &&
      socket_table[s].queue_count == 0) return -CFG_EAGAIN;
  return socket_receive_datagram(caller, s, values[0], values[1],
    values[3], values[4]);
}

int socket_poll(int socket, int events) {
  int ready;
  if (socket < 0 || socket >= CFG_NSOCKET ||
      socket_table[socket].used == 0) return CFG_POLLERR;
  ready = 0;
  if ((events & CFG_POLLIN) != 0 &&
      socket_table[socket].queue_count > 0) ready = ready | CFG_POLLIN;
  if ((events & CFG_POLLOUT) != 0) ready = ready | CFG_POLLOUT;
  return ready;
}

void socket_close(int socket) {
  if (socket < 0 || socket >= CFG_NSOCKET ||
      socket_table[socket].used == 0) return;
  socket_table[socket].refs = socket_table[socket].refs - 1;
  if (socket_table[socket].refs == 0) socket_table[socket].used = 0;
  poll_wakeup();
}

void socket_retain(int socket) {
  if (socket >= 0 && socket < CFG_NSOCKET &&
      socket_table[socket].used != 0) {
    socket_table[socket].refs = socket_table[socket].refs + 1;
  }
}
