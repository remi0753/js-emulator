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

// Registered handler for the keyboard IRQ line (see device_init / request_irq).
void keyboard_isr(void) {
  kbd_drain();
  wakeup(&kbd_chan);
}

// Trap-stub entry invoked by the assembly keyboard vector. Routes the line
// through the driver-model IRQ table rather than calling the driver directly.
void on_keyboard_irq(void) {
  irq_dispatch(CFG_KBD_IRQ);
}
