// Linux-like device and driver model (Phase 26).
//
// Devices are no longer ad hoc port users scattered through the VFS. Each
// character device is a kernel object registered with a major number, a name,
// permission bits, and an operation table (read/write). devfs resolves /dev
// names through this registry, and reads/writes dispatch through the registered
// driver instead of a hard-coded switch.
//
// Device interrupts are routed the same way: a driver calls request_irq() to
// own an IRQ line, and the per-line trap stub funnels through irq_dispatch(),
// which looks up and invokes the registered handler. The /sys pseudo-filesystem
// exposes the registry for inspection (/sys/devices, /sys/irq).
#include "kernel.h"

struct chardev chardev_table[CFG_NCHARDEV];
struct irq_slot irq_table[CFG_NIRQ];
struct vnode_ops sys_vnode_ops;
char sys_text[256];

int sys_text_size(void) {
  return 256;
}

// --- char-device driver registration ---

void copy_name(char *dst, char *src) {
  int i;
  i = 0;
  while (i < 11 && src[i] != 0) {
    dst[i] = src[i];
    i = i + 1;
  }
  dst[i] = 0;
}

int register_chardev(
  int major, char *name, int mode, vnode_io_fn read, vnode_io_fn write
) {
  if (major <= 0 || major >= CFG_NCHARDEV) return -CFG_EINVAL;
  if (chardev_table[major].used != 0) return -CFG_EEXIST;
  chardev_table[major].used = 1;
  chardev_table[major].major = major;
  chardev_table[major].mode = mode;
  copy_name(chardev_table[major].name, name);
  chardev_table[major].read = read;
  chardev_table[major].write = write;
  return 0;
}

// Resolve a /dev name to its major number, or -1 if no driver claims it.
int chardev_lookup(char *name) {
  int i;
  i = 1;
  while (i < CFG_NCHARDEV) {
    if (chardev_table[i].used != 0 &&
        strcmp(chardev_table[i].name, name) == 0) {
      return i;
    }
    i = i + 1;
  }
  return -1;
}

// rdev encoding: major in the high byte, minor in the low byte (one minor per
// driver here). Matches the classic Linux makedev layout closely enough for
// userspace inspection.
int chardev_rdev(int major) {
  return (major << 8);
}

int chardev_read(int major, int node, int caller, int off, int buf, int len) {
  if (major <= 0 || major >= CFG_NCHARDEV || chardev_table[major].used == 0 ||
      chardev_table[major].read == 0) {
    return -CFG_ENODEV;
  }
  return chardev_table[major].read(node, caller, off, buf, len);
}

int chardev_write(int major, int node, int caller, int off, int buf, int len) {
  if (major <= 0 || major >= CFG_NCHARDEV || chardev_table[major].used == 0 ||
      chardev_table[major].write == 0) {
    return -CFG_ENODEV;
  }
  return chardev_table[major].write(node, caller, off, buf, len);
}

// --- char-device driver bodies ---
//
// Each takes the vnode_io_fn shape (node, caller, off, buf, len). The caller's
// page directory is live during the syscall, so user buffer addresses are
// directly accessible (the same convention dev/zero already relied on).

int cd_console_read(int node, int caller, int off, int buf, int len) {
  return tty_read(caller, buf, len);
}

int cd_console_write(int node, int caller, int off, int buf, int len) {
  return tty_write(caller, buf, len);
}

int cd_null_read(int node, int caller, int off, int buf, int len) {
  return 0;
}

int cd_sink_write(int node, int caller, int off, int buf, int len) {
  return len;
}

int cd_zero_read(int node, int caller, int off, int buf, int len) {
  int i;
  i = 0;
  while (i < len) {
    write8_at(buf + i, 0);
    i = i + 1;
  }
  return len;
}

int cd_rtc_read(int node, int caller, int off, int buf, int len) {
  char value[4];
  int now;
  int take;
  int i;
  if (off >= 4) return 0;
  now = rtc_time();
  value[0] = now & 0xff;
  value[1] = (now >> 8) & 0xff;
  value[2] = (now >> 16) & 0xff;
  value[3] = (now >> 24) & 0xff;
  take = 4 - off;
  if (take > len) take = len;
  i = 0;
  while (i < take) {
    write8_at(buf + i, value[off + i]);
    i = i + 1;
  }
  return take;
}

int cd_random_read(int node, int caller, int off, int buf, int len) {
  int i;
  i = 0;
  while (i < len) {
    write8_at(buf + i, __in(CFG_ENTROPY) & 0xff);
    i = i + 1;
  }
  return len;
}

// /dev/kmsg: read the kernel log buffer (Phase 27 dmesg surface). The device
// read passes the file offset through `off`, so a reader streams the whole log.
int cd_kmsg_read(int node, int caller, int off, int buf, int len) {
  return klog_read(off, buf, len);
}

// --- IRQ ownership and routing ---

int request_irq(int line, irq_fn handler, char *owner) {
  if (line < 0 || line >= CFG_NIRQ) return -CFG_EINVAL;
  if (irq_table[line].used != 0) return -CFG_EEXIST;
  irq_table[line].used = 1;
  irq_table[line].handler = handler;
  copy_name(irq_table[line].owner, owner);
  return 0;
}

// Called from the per-line assembly trap stubs (via on_keyboard_irq /
// on_network_irq). Routes the IRQ to whichever driver owns the line.
void irq_dispatch(int line) {
  if (line < 0 || line >= CFG_NIRQ) return;
  if (irq_table[line].used != 0 && irq_table[line].handler != 0) {
    irq_table[line].handler();
  }
}

// --- /sys inspection surface ---
//
// /sys is a tiny pseudo-filesystem. Generated files are truncated to sys_text's
// capacity rather than writing past the scratch buffer as more drivers appear.

int sys_append_char(int n, int c) {
  if (n < sys_text_size()) {
    sys_text[n] = c;
  }
  return n + 1;
}

int sys_append_text(int n, char *text) {
  int i;
  i = 0;
  while (text[i] != 0) {
    n = sys_append_char(n, text[i]);
    i = i + 1;
  }
  return n;
}

int sys_append_number(int n, int value) {
  char digits[12];
  int count;
  int i;
  if (value == 0) {
    return sys_append_char(n, '0');
  }
  count = 0;
  while (value > 0) {
    digits[count] = '0' + value % 10;
    value = value / 10;
    count = count + 1;
  }
  i = count - 1;
  while (i >= 0) {
    n = sys_append_char(n, digits[i]);
    i = i - 1;
  }
  return n;
}

int sys_finish_len(int n) {
  if (n > sys_text_size()) return sys_text_size();
  return n;
}

int sys_build_devices(void) {
  int i;
  int n;
  n = 0;
  i = 1;
  while (i < CFG_NCHARDEV) {
    if (chardev_table[i].used != 0) {
      n = sys_append_number(n, chardev_table[i].major);
      n = sys_append_char(n, ' ');
      n = sys_append_text(n, chardev_table[i].name);
      n = sys_append_char(n, '\n');
    }
    i = i + 1;
  }
  return sys_finish_len(n);
}

int sys_build_irq(void) {
  int i;
  int n;
  n = 0;
  i = 0;
  while (i < CFG_NIRQ) {
    if (irq_table[i].used != 0) {
      n = sys_append_number(n, i);
      n = sys_append_char(n, ' ');
      n = sys_append_text(n, irq_table[i].owner);
      n = sys_append_char(n, '\n');
    }
    i = i + 1;
  }
  return sys_finish_len(n);
}

// /sys/trace holds the runtime trace bitmask as a decimal number plus newline.
int sys_build_trace(void) {
  int n;
  n = sys_append_number(0, trace_flags);
  n = sys_append_char(n, '\n');
  return sys_finish_len(n);
}

int sys_text_for(int object) {
  if (object == 1) return sys_build_devices();
  if (object == 2) return sys_build_irq();
  if (object == 3) return sys_build_trace();
  return 0;
}

int sys_lookup(char *relative, struct vnode *node) {
  if (relative[0] == 0) {
    vnode_fill(node, &sys_vnode_ops, CFG_FS_SYS, 0,
      CFG_T_DIR, CFG_S_IFDIR | 365, 0);
    node->inode.nlink = 2;
    return 0;
  }
  if (strcmp(relative, "devices") == 0) {
    vnode_fill(node, &sys_vnode_ops, CFG_FS_SYS, 1,
      CFG_T_FILE, CFG_S_IFREG | 292, sys_build_devices());
    return 0;
  }
  if (strcmp(relative, "irq") == 0) {
    vnode_fill(node, &sys_vnode_ops, CFG_FS_SYS, 2,
      CFG_T_FILE, CFG_S_IFREG | 292, sys_build_irq());
    return 0;
  }
  // Writable: 0644 so root can toggle tracing by writing the bitmask.
  if (strcmp(relative, "trace") == 0) {
    vnode_fill(node, &sys_vnode_ops, CFG_FS_SYS, 3,
      CFG_T_FILE, CFG_S_IFREG | 420, sys_build_trace());
    return 0;
  }
  return -CFG_ENOENT;
}

int sys_read_op(int node_addr, int caller, int off, int buf, int len) {
  struct vnode *node;
  int total;
  int take;
  node = node_addr;
  if (node->object == 0) return -CFG_EISDIR;
  total = sys_text_for(node->object);
  if (off >= total) return 0;
  take = total - off;
  if (take > len) take = len;
  memcpy(buf, sys_text + off, take);
  return take;
}

// Parse a decimal value out of the user buffer and set the trace bitmask.
int sys_write_op(int node_addr, int caller, int off, int buf, int len) {
  struct vnode *node;
  int value;
  int i;
  int c;
  node = node_addr;
  if (node->object != 3) return -CFG_EROFS;
  value = 0;
  i = 0;
  while (i < len) {
    c = read8_at(buf + i);
    if (c >= '0' && c <= '9') value = value * 10 + c - '0';
    i = i + 1;
  }
  trace_flags = value;
  return len;
}

// /sys/trace is rewritable (shell redirection truncates before writing); the
// other /sys nodes are read-only.
int sys_truncate_op(int node_addr) {
  struct vnode *node;
  node = node_addr;
  if (node->object != 3) return -CFG_EROFS;
  return 0;
}

int sys_getdents_op(
  int node_addr, int caller, int offset_addr, int destination, int count
) {
  struct vnode *node;
  int *offset;
  int written;
  char *name;
  node = node_addr;
  offset = offset_addr;
  if (node->inode.type != CFG_T_DIR) return -CFG_ENOTDIR;
  if (count < sizeof(struct guest_dirent)) return -CFG_EINVAL;
  written = 0;
  while (*offset < 3 &&
      written + sizeof(struct guest_dirent) <= count) {
    if (*offset == 0) name = "devices";
    else if (*offset == 1) name = "irq";
    else name = "trace";
    if (emit_dirent(caller, destination + written, *offset + 1,
        *offset + 1, CFG_T_FILE, name) < 0) return -CFG_EFAULT;
    *offset = *offset + 1;
    written = written + sizeof(struct guest_dirent);
  }
  return written;
}

// --- bring-up: register built-in drivers and IRQ handlers ---

void require_chardev(
  int major, char *name, int mode, vnode_io_fn read, vnode_io_fn write
) {
  if (register_chardev(major, name, mode, read, write) < 0) {
    panic("chardev registration failed");
  }
}

void require_irq(int line, irq_fn handler, char *owner) {
  if (request_irq(line, handler, owner) < 0) {
    panic("irq registration failed");
  }
}

void device_init(void) {
  int i;
  i = 0;
  while (i < CFG_NCHARDEV) {
    chardev_table[i].used = 0;
    i = i + 1;
  }
  i = 0;
  while (i < CFG_NIRQ) {
    irq_table[i].used = 0;
    i = i + 1;
  }

  // Char devices. Majors 1-4 keep their historical object ids (console=1,
  // tty=4) so vnode_is_tty() and existing /dev ordering stay stable.
  require_chardev(1, "console", CFG_S_IFCHR | 438, cd_console_read,
    cd_console_write);
  require_chardev(2, "null", CFG_S_IFCHR | 438, cd_null_read, cd_sink_write);
  require_chardev(3, "zero", CFG_S_IFCHR | 438, cd_zero_read, cd_sink_write);
  require_chardev(4, "tty", CFG_S_IFCHR | 438, cd_console_read,
    cd_console_write);
  require_chardev(5, "rtc", CFG_S_IFCHR | 292, cd_rtc_read, cd_sink_write);
  require_chardev(6, "random", CFG_S_IFCHR | 292, cd_random_read,
    cd_sink_write);
  require_chardev(7, "urandom", CFG_S_IFCHR | 292, cd_random_read,
    cd_sink_write);
  require_chardev(8, "kmsg", CFG_S_IFCHR | 292, cd_kmsg_read, cd_sink_write);

  // IRQ ownership: device drivers claim their interrupt lines. The timer
  // (line CFG_TIMER_IRQ) stays a dedicated scheduler stub and is not routed
  // through this table.
  require_irq(CFG_KBD_IRQ, keyboard_isr, "keyboard");
  require_irq(CFG_NET_IRQ, network_drain, "net");

  sys_vnode_ops.read = sys_read_op;
  sys_vnode_ops.write = sys_write_op;
  sys_vnode_ops.getdents = sys_getdents_op;
  sys_vnode_ops.stat = generic_stat_op;
  sys_vnode_ops.truncate = sys_truncate_op;
  sys_vnode_ops.release = 0;
}
