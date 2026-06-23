// ls: list a directory's entries (one name per line). Reads the directory as a
// file of fixed 16-byte records { u16 inum, char name[14] }, the on-disk dirent
// format -- the same approach xv6's ls uses.

char db[16];

int main(int argc, char **argv) {
  char *path;
  int fd;
  int n;
  int inum;
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
  n = read(fd, db, 16);
  while (n == 16) {
    inum = (db[0] & 255) | ((db[1] & 255) << 8);
    if (inum != 0) {
      j = 2;
      while (j < 16 && db[j] != 0) {
        write(1, db + j, 1);
        j = j + 1;
      }
      write(1, "\n", 1);
    }
    n = read(fd, db, 16);
  }
  close(fd);
  return 0;
}
