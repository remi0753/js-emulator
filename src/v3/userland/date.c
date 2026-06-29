// date: print the current wall-clock time as a Unix timestamp.
#include "libc.h"

int main(int argc, char **argv) {
  int t;
  t = time(NULL);
  print_int(t);
  fputc('\n', stdout);
  return 0;
}
