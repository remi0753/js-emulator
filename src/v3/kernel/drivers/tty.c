// TTY line discipline.
//
// The keyboard device supplies raw bytes here. Canonical mode edits one line
// before making it readable, raw mode makes bytes immediately available, and
// ISIG converts configured control characters into foreground-group signals.
#include "kernel.h"

int tty_foreground_pgid;
int tty_closed;
int tty_eof_pending;
int tty_input_head;
int tty_input_count;
int tty_edit_count;
char tty_input[512];
char tty_edit[128];
struct guest_termios tty_termios;
struct guest_winsize tty_winsize;

void tty_echo_char(int ch) {
  if ((tty_termios.lflag & CFG_TTY_ECHO) != 0) serial_putc(ch);
}

void tty_echo_erase(void) {
  if ((tty_termios.lflag & CFG_TTY_ECHO) == 0) return;
  if ((tty_termios.lflag & CFG_TTY_ECHOE) != 0) {
    serial_putc(8);
    serial_putc(' ');
    serial_putc(8);
  }
}

void tty_queue(int ch) {
  if (tty_input_count >= 512) return;
  tty_input[(tty_input_head + tty_input_count) % 512] = ch;
  tty_input_count = tty_input_count + 1;
}

void tty_commit_edit(void) {
  int i;
  i = 0;
  while (i < tty_edit_count) {
    tty_queue(tty_edit[i]);
    i = i + 1;
  }
  tty_edit_count = 0;
}

void tty_discard_edit(void) {
  while (tty_edit_count > 0) {
    tty_edit_count = tty_edit_count - 1;
    tty_echo_erase();
  }
}

void tty_init(void) {
  int i;
  tty_foreground_pgid = 0;
  tty_closed = 0;
  tty_eof_pending = 0;
  tty_input_head = 0;
  tty_input_count = 0;
  tty_edit_count = 0;
  memset(&tty_termios, 0, sizeof(struct guest_termios));
  tty_termios.lflag =
    CFG_TTY_ISIG | CFG_TTY_ICANON | CFG_TTY_ECHO | CFG_TTY_ECHOE;
  i = 0;
  while (i < 12) {
    tty_termios.cc[i] = 0;
    i = i + 1;
  }
  tty_termios.cc[CFG_TTY_VINTR] = 3;
  tty_termios.cc[CFG_TTY_VERASE] = 127;
  tty_termios.cc[CFG_TTY_VKILL] = 21;
  tty_termios.cc[CFG_TTY_VEOF] = 4;
  tty_termios.cc[CFG_TTY_VMIN] = 1;
  tty_termios.cc[CFG_TTY_VSUSP] = 26;
  tty_winsize.rows = 24;
  tty_winsize.cols = 80;
  tty_winsize.xpixel = 0;
  tty_winsize.ypixel = 0;
}

void tty_receive(int ch) {
  if (ch == '\r') ch = '\n';
  if ((tty_termios.lflag & CFG_TTY_ISIG) != 0) {
    if (ch == tty_termios.cc[CFG_TTY_VINTR]) {
      tty_discard_edit();
      if ((tty_termios.lflag & CFG_TTY_ECHO) != 0) serial_write("^C\n");
      send_signal_group(tty_foreground_pgid, CFG_SIGINT);
      return;
    }
    if (ch == tty_termios.cc[CFG_TTY_VSUSP]) {
      tty_discard_edit();
      if ((tty_termios.lflag & CFG_TTY_ECHO) != 0) serial_write("^Z\n");
      send_signal_group(tty_foreground_pgid, CFG_SIGTSTP);
      return;
    }
  }
  if ((tty_termios.lflag & CFG_TTY_ICANON) == 0) {
    tty_queue(ch);
    tty_echo_char(ch);
    return;
  }
  if (ch == tty_termios.cc[CFG_TTY_VERASE] || ch == 8) {
    if (tty_edit_count > 0) {
      tty_edit_count = tty_edit_count - 1;
      tty_echo_erase();
    }
    return;
  }
  if (ch == tty_termios.cc[CFG_TTY_VKILL]) {
    tty_discard_edit();
    return;
  }
  if (ch == tty_termios.cc[CFG_TTY_VEOF]) {
    if (tty_edit_count > 0) tty_commit_edit();
    else tty_eof_pending = tty_eof_pending + 1;
    return;
  }
  if (tty_edit_count < 128) {
    tty_edit[tty_edit_count] = ch;
    tty_edit_count = tty_edit_count + 1;
    tty_echo_char(ch);
  }
  if (ch == '\n') tty_commit_edit();
}

void tty_close_input(void) {
  if (tty_closed != 0) return;
  tty_closed = 1;
  if (tty_edit_count > 0) tty_commit_edit();
}

int tty_read(int caller, int buf, int len) {
  int n;
  int ch;
  if (len == 0) return 0;
  kbd_drain();
  if (proc_table[caller].pgid != tty_foreground_pgid) {
    send_signal_group(proc_table[caller].pgid, CFG_SIGTTIN);
    return -CFG_EINTR;
  }
  if (tty_input_count == 0) {
    if (tty_eof_pending > 0) {
      tty_eof_pending = tty_eof_pending - 1;
      return 0;
    }
    if (tty_closed != 0) return 0;
    if ((tty_termios.lflag & CFG_TTY_ICANON) == 0 &&
        tty_termios.cc[CFG_TTY_VMIN] == 0) return 0;
    g_noret = 1;
    proc_table[caller].ctx.pc =
      proc_table[caller].ctx.pc - CFG_SYSCALL_INSTR_SIZE;
    sleep(caller, &kbd_chan);
    return 0;
  }
  n = 0;
  while (n < len && tty_input_count > 0) {
    ch = tty_input[tty_input_head];
    tty_input_head = (tty_input_head + 1) % 512;
    tty_input_count = tty_input_count - 1;
    write8_at(buf + n, ch);
    n = n + 1;
    if ((tty_termios.lflag & CFG_TTY_ICANON) != 0 && ch == '\n') return n;
  }
  return n;
}

int tty_write(int caller, int buf, int len) {
  int i;
  i = 0;
  while (i < len) {
    serial_putc(read8_at(buf + i));
    i = i + 1;
  }
  return len;
}

int tty_getattr(int caller, int destination) {
  return copyout(caller, destination, &tty_termios,
    sizeof(struct guest_termios));
}

int tty_setattr(int caller, int source, int flush) {
  struct guest_termios value;
  if (copyin(caller, &value, source, sizeof(struct guest_termios)) < 0) {
    return -CFG_EFAULT;
  }
  memcpy(&tty_termios, &value, sizeof(struct guest_termios));
  if (flush != 0) {
    tty_input_head = 0;
    tty_input_count = 0;
    tty_edit_count = 0;
    tty_eof_pending = 0;
  }
  return 0;
}

int tty_getwinsize(int caller, int destination) {
  return copyout(caller, destination, &tty_winsize,
    sizeof(struct guest_winsize));
}

int tty_setwinsize(int caller, int source) {
  struct guest_winsize value;
  if (copyin(caller, &value, source,
      sizeof(struct guest_winsize)) < 0) return -CFG_EFAULT;
  if (value.rows <= 0 || value.cols <= 0) return -CFG_EINVAL;
  memcpy(&tty_winsize, &value, sizeof(struct guest_winsize));
  return 0;
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
  if (found == 0) return -CFG_ESRCH;
  tty_foreground_pgid = pgid;
  return 0;
}

int tty_get_foreground(void) {
  return tty_foreground_pgid;
}
