// dmesg: print the kernel log buffer (Phase 27 observability), read from the
// /dev/kmsg character device exposed by the guest kernel.
#include "libc.h"

char buf[512];

int main(int argc, char **argv) {
  int fd;
  int n;
  int off;
  int wrote;
  fd = open("/dev/kmsg", 0);
  if (fd < 0) {
    write(2, "dmesg: cannot open /dev/kmsg\n", 29);
    return 1;
  }
  n = read(fd, buf, 512);
  while (n > 0) {
    off = 0;
    while (off < n) {
      wrote = write(1, buf + off, n - off);
      if (wrote <= 0) {
        close(fd);
        return 1;
      }
      off = off + wrote;
    }
    n = read(fd, buf, 512);
  }
  close(fd);
  return 0;
}
