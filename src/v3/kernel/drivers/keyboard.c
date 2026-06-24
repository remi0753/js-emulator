// Keyboard driver: drain raw device bytes into the TTY line discipline.
#include "kernel.h"

int kbd_chan; // wait channel; readers sleep on &kbd_chan until input arrives

void keyboard_init(void) {
  tty_init();
}

void kbd_drain(void) {
  int status;
  int ch;
  status = __in(CFG_KBD_STATUS);
  while ((status & 1) != 0) {
    ch = __in(CFG_KBD_DATA);
    tty_receive(ch);
    status = __in(CFG_KBD_STATUS);
  }
  if ((status & 2) != 0) tty_close_input();
}

void on_keyboard_irq(void) {
  kbd_drain();
  wakeup(&kbd_chan);
}
