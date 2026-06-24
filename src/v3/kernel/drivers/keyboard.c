// Keyboard driver: a polled data port plus a status bit that signals EOF.
#include "kernel.h"

int kbd_chan; // wait channel; readers sleep on &kbd_chan until input arrives
int tty_foreground_pgid;
int kbd_head;
int kbd_count;
char kbd_buffer[256];

void keyboard_init(void) {
  tty_foreground_pgid = 0;
  kbd_head = 0;
  kbd_count = 0;
}

void kbd_drain(void) {
  int status;
  int ch;
  status = __in(CFG_KBD_STATUS);
  while ((status & 1) != 0) {
    ch = __in(CFG_KBD_DATA);
    if (ch == 3) {
      send_signal_group(tty_foreground_pgid, CFG_SIGINT);
    } else if (kbd_count < 256) {
      kbd_buffer[(kbd_head + kbd_count) % 256] = ch;
      kbd_count = kbd_count + 1;
    }
    status = __in(CFG_KBD_STATUS);
  }
}

// Read one byte from the guest TTY input buffer; 0 means no byte available.
int kbd_getc(void) {
  int ch;
  if (kbd_count == 0) {
    kbd_drain();
  }
  if (kbd_count == 0) {
    return 0;
  }
  ch = kbd_buffer[kbd_head];
  kbd_head = (kbd_head + 1) % 256;
  kbd_count = kbd_count - 1;
  return ch;
}

// True once the input stream has signaled end-of-file (status bit 1).
int kbd_eof(void) {
  int status;
  status = __in(CFG_KBD_STATUS);
  return kbd_count == 0 && (status & 1) == 0 && (status & 2) != 0;
}

// Drain hardware input into the guest buffer. Ctrl-C is terminal input, not a
// byte read by the foreground program: it becomes SIGINT for the foreground
// process group.
void on_keyboard_irq(void) {
  kbd_drain();
  wakeup(&kbd_chan);
}

int tty_set_foreground(int caller, int pgid) {
  int i;
  int found;
  found = 0;
  i = 0;
  while (i < nproc) {
    if (proc_table[i].state != CFG_ST_UNUSED &&
        proc_table[i].pgid == pgid &&
        proc_table[i].sid == proc_table[caller].sid) {
      found = 1;
    }
    i = i + 1;
  }
  if (found == 0) {
    return -CFG_ESRCH;
  }
  tty_foreground_pgid = pgid;
  return 0;
}

int tty_get_foreground(void) {
  return tty_foreground_pgid;
}
