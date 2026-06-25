#include "libc.h"

int main(int argc, char **argv) {
  int fd;
  int i;
  int result;
  result = 0;
  i = 1;
  while (i < argc) {
    fd = open(argv[i], 0x202);
    if (fd < 0) result = 1;
    else close(fd);
    i = i + 1;
  }
  return result;
}
