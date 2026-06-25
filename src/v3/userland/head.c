#include "libc.h"

int main(int argc, char **argv) {
  int fd;
  int lines;
  int n;
  char c;
  fd = 0;
  if (argc > 1) {
    fd = open(argv[1], 0);
    if (fd < 0) return 1;
  }
  lines = 0;
  n = read(fd, &c, 1);
  while (n == 1 && lines < 10) {
    write(1, &c, 1);
    if (c == '\n') lines = lines + 1;
    n = read(fd, &c, 1);
  }
  if (fd != 0) close(fd);
  return 0;
}
