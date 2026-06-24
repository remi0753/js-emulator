// Serial console driver and kernel panic.
#include "kernel.h"

void serial_putc(int ch) {
  __out(CFG_CONSOLE_DATA, ch);
}

void serial_write(char *s) {
  int i;
  i = 0;
  while (s[i] != 0) {
    serial_putc(s[i]);
    i = i + 1;
  }
}

void panic(char *msg) {
  serial_write("kernel: PANIC: ");
  serial_write(msg);
  serial_putc('\n');
  __di();
  __halt();
}
