#include "libc.h"

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  if (rename(argv[1], argv[2]) < 0) return 1;
  return 0;
}
