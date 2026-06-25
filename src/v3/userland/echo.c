// echo: print the arguments separated by spaces, followed by a newline.
#include "libc.h"

int main(int argc, char **argv) {
  int i;
  i = 1;
  while (i < argc) {
    write(1, argv[i], strlen(argv[i]));
    if (i + 1 < argc) {
      write(1, " ", 1);
    }
    i = i + 1;
  }
  fputc('\n', stdout);
  return 0;
}
