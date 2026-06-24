// Keyboard driver: a polled data port plus a status bit that signals EOF.
#include "kernel.h"

// Read one byte from the keyboard buffer; 0 means "no byte available".
int kbd_getc(void) {
  return __in(CFG_KBD_DATA);
}

// True once the input stream has signaled end-of-file (status bit 1).
int kbd_eof(void) {
  return (__in(CFG_KBD_STATUS) & 2) != 0;
}
