// cat: copy each named file to stdout; with no arguments, copy stdin to stdout
// (so it works as the tail of a pipeline).

char buf[512];

void copy_fd(int fd) {
  int n;
  int off;
  int wrote;
  n = read(fd, buf, 512);
  while (n > 0) {
    off = 0;
    while (off < n) {
      wrote = write(1, buf + off, n - off);
      if (wrote <= 0) {
        return;
      }
      off = off + wrote;
    }
    n = read(fd, buf, 512);
  }
}

int main(int argc, char **argv) {
  int i;
  int fd;
  if (argc < 2) {
    copy_fd(0);
    return 0;
  }
  i = 1;
  while (i < argc) {
    fd = open(argv[i], 0);
    if (fd < 0) {
      write(2, "cat: cannot open\n", 17);
    } else {
      copy_fd(fd);
      close(fd);
    }
    i = i + 1;
  }
  return 0;
}
