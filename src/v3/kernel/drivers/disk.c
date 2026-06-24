// PIO block-disk driver: read a 512-byte block through the disk ports.
#include "kernel.h"

void disk_read_block(int blockno, int dst) {
  int *p;
  int i;
  __out(CFG_DISK_POS, blockno);
  p = dst;
  i = 0;
  while (i < 128) { // 512 bytes / 4 bytes per word
    p[i] = __in(CFG_DISK_DATA);
    i = i + 1;
  }
}
