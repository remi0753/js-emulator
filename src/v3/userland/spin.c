// A deliberately CPU-bound foreground job used to exercise terminal SIGINT.
#include "libc.h"
int main(int argc, char **argv) {
  while (1) {
  }
  return 0;
}
