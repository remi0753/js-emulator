#include "libc.h"

int main(int argc, char **argv) {
  int i;
  int result;
  result = 0;
  i = 1;
  while (i < argc) {
    if (unlink(argv[i]) < 0) result = 1;
    i = i + 1;
  }
  return result;
}
