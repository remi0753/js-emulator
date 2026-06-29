// PIO block-disk driver: read a 512-byte block through the disk ports.
#include "kernel.h"

// Scratch globals handing parameters to the hand-written PIO loops below. Disk
// I/O only runs in syscall/fault context with interrupts masked and never yields
// between the store and the asm that consumes it, so a single shared pair is safe
// (the driver is never re-entered).
int disk_pio_buf;
int disk_pio_port;

void disk_read_block(int blockno, int dst) {
  if ((trace_flags & CFG_TRACE_DISK) != 0) {
    klog("trace: disk read blk=");
    klog_int(blockno);
    klog("\n");
  }
  __out(CFG_DISK_POS, blockno);
  disk_pio_buf = dst;
  disk_pio_port = CFG_DISK_DATA;
  // Hand-written PIO copy loop. The naive stack-machine codegen of the 128-word
  // C loop spent ~8K instructions per block; this is ~7 per word. It runs 128
  // times for every block read and demand-paging a program reads thousands of
  // blocks, so it is the single hottest kernel loop. Uses R0..R3 only, preserving
  // R6 (frame base) and the software stack; the 'asm' codegen flushes __csp first.
  asm(
    "LOAD R0, disk_pio_buf\n"   // R0 = destination cursor
    "LOAD R1, disk_pio_port\n"  // R1 = disk data port
    "MOV R2, 512\n"
    "ADD R2, R0\n"              // R2 = end of the 512-byte buffer
    "disk_read_pio:\n"
    "IN R3, R1\n"               // R3 = next word from the disk
    "STORER R0, R3\n"           // *cursor = word
    "MOV R3, 4\n"
    "ADD R0, R3\n"              // cursor += 4
    "CMP R0, R2\n"
    "JB disk_read_pio\n"
  );
}

void disk_write_block(int blockno, int src) {
  if ((trace_flags & CFG_TRACE_DISK) != 0) {
    klog("trace: disk write blk=");
    klog_int(blockno);
    klog("\n");
  }
  __out(CFG_DISK_POS, blockno);
  disk_pio_buf = src;
  disk_pio_port = CFG_DISK_DATA;
  asm(
    "LOAD R0, disk_pio_buf\n"   // R0 = source cursor
    "LOAD R1, disk_pio_port\n"  // R1 = disk data port
    "MOV R2, 512\n"
    "ADD R2, R0\n"              // R2 = end of the 512-byte buffer
    "disk_write_pio:\n"
    "LOADR R3, R0\n"            // R3 = *cursor
    "OUT R1, R3\n"             // port = word
    "MOV R3, 4\n"
    "ADD R0, R3\n"              // cursor += 4
    "CMP R0, R2\n"
    "JB disk_write_pio\n"
  );
}
