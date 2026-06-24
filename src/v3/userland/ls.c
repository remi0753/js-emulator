// ls: list a directory's entries through the libc getdents() wrapper.

struct dirent {
  int ino;
  int offset;
  int reclen;
  int type;
  char name[16];
};

struct dirent entries[4];

int main(int argc, char **argv) {
  char *path;
  int fd;
  int n;
  int i;
  int j;
  if (argc >= 2) {
    path = argv[1];
  } else {
    path = "/";
  }
  fd = open(path, 0);
  if (fd < 0) {
    write(2, "ls: cannot open\n", 16);
    return 1;
  }
  n = getdents(fd, entries, sizeof(struct dirent) * 4);
  while (n > 0) {
    i = 0;
    while (i < n / sizeof(struct dirent)) {
      j = 0;
      while (j < 16 && entries[i].name[j] != 0) {
        write(1, entries[i].name + j, 1);
        j = j + 1;
      }
      write(1, "\n", 1);
      i = i + 1;
    }
    n = getdents(fd, entries, sizeof(struct dirent) * 4);
  }
  close(fd);
  return 0;
}
