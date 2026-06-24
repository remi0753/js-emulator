// Keyboard driver: a polled data port plus a status bit that signals EOF.
#include "kernel.h"

int kbd_chan; // wait channel; readers sleep on &kbd_chan until input arrives

// Read one byte from the keyboard buffer; 0 means "no byte available".
int kbd_getc(void) {
  return __in(CFG_KBD_DATA);
}

// True once the input stream has signaled end-of-file (status bit 1).
int kbd_eof(void) {
  return (__in(CFG_KBD_STATUS) & 2) != 0;
}

// Keyboard IRQ body: a key (or EOF) arrived, so wake any blocked readers.
void on_keyboard_irq(void) {
  wakeup(&kbd_chan);
}
