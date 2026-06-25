#include "libc.h"

char wc_buffer[256];

int count_fd(int fd) {
  int bytes;
  int lines;
  int words;
  int in_word;
  int n;
  int i;
  bytes = 0;
  lines = 0;
  words = 0;
  in_word = 0;
  n = read(fd, wc_buffer, 256);
  while (n > 0) {
    bytes = bytes + n;
    i = 0;
    while (i < n) {
      if (wc_buffer[i] == '\n') lines = lines + 1;
      if (wc_buffer[i] == ' ' || wc_buffer[i] == '\n' || wc_buffer[i] == '\t') {
        in_word = 0;
      } else if (in_word == 0) {
        words = words + 1;
        in_word = 1;
      }
      i = i + 1;
    }
    n = read(fd, wc_buffer, 256);
  }
  print_int(lines);
  write(1, " ", 1);
  print_int(words);
  write(1, " ", 1);
  print_int(bytes);
  write(1, "\n", 1);
  return 0;
}

int main(int argc, char **argv) {
  int fd;
  if (argc < 2) return count_fd(0);
  fd = open(argv[1], 0);
  if (fd < 0) return 1;
  count_fd(fd);
  close(fd);
  return 0;
}
