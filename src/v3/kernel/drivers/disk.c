// PIO block-disk driver: read a 512-byte block through the disk ports.
#include "kernel.h"

void disk_read_block(int blockno, int dst) {
  int *p;
  int *end;
  if ((trace_flags & CFG_TRACE_DISK) != 0) {
    klog("trace: disk read blk=");
    klog_int(blockno);
    klog("\n");
  }
  __out(CFG_DISK_POS, blockno);
  p = dst;
  end = p + 128; // 512 bytes / 4 bytes per word
  // Pointer-walk rather than index: the naive backend would otherwise recompute
  // p + i*4 every iteration. This loop runs 128 times for every block read, and
  // demand-paging a program reads thousands of blocks, so it is hot.
  while (p < end) {
    *p = __in(CFG_DISK_DATA);
    p = p + 1;
  }
}

void disk_write_block(int blockno, int src) {
  int *p;
  int *end;
  if ((trace_flags & CFG_TRACE_DISK) != 0) {
    klog("trace: disk write blk=");
    klog_int(blockno);
    klog("\n");
  }
  __out(CFG_DISK_POS, blockno);
  p = src;
  end = p + 128;
  while (p < end) {
    __out(CFG_DISK_DATA, *p);
    p = p + 1;
  }
}
