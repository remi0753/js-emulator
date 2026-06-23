// date: print the current wall-clock time, as a Unix timestamp in whole
// seconds, on one line. The time comes from the RTC device via the time()
// syscall (Phase 16). Digits are formatted by hand -- there is no stdio yet.

char buf[16];

int main(int argc, char **argv) {
  int t;
  int i;
  int j;
  t = time();
  if (t == 0) {
    write(1, "0\n", 2);
    return 0;
  }
  // Emit digits least-significant first into buf, then write them reversed.
  i = 0;
  while (t > 0) {
    buf[i] = '0' + (t % 10);
    t = t / 10;
    i = i + 1;
  }
  j = 0;
  while (j < i) {
    write(1, buf + (i - 1 - j), 1);
    j = j + 1;
  }
  write(1, "\n", 1);
  return 0;
}
