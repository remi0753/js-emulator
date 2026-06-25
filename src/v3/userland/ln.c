#include "libc.h"

int main(int argc, char **argv) {
  if (argc == 4 && strcmp(argv[1], "-s") == 0) {
    if (symlink(argv[2], argv[3]) < 0) return 1;
    return 0;
  }
  if (argc != 3) return 2;
  if (link(argv[1], argv[2]) < 0) return 1;
  return 0;
}
