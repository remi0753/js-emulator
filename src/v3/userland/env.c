#include "libc.h"

int main(int argc, char **argv) {
  int i;
  i = 0;
  while (environ != 0 && environ[i] != 0) {
    puts(environ[i]);
    i = i + 1;
  }
  return 0;
}
