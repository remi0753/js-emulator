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
  klog("kernel: PANIC: ");
  klog(msg);
  klog_putc('\n');
  dump_state(); // report the offending process context (pid/pc/sp/mode)
  __di();
  __halt();
}
