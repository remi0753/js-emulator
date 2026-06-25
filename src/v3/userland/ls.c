// ls: getdents-based directory listing with a compact ls -l metadata view.
#include "libc.h"

char fullpath[64];
char modebuf[11];
char linkbuf[64];

void format_mode(int mode) {
  int bits[9];
  char chars[9];
  int i;
  if ((mode & 0xf000) == 0x4000) modebuf[0] = 'd';
  else if ((mode & 0xf000) == 0xa000) modebuf[0] = 'l';
  else modebuf[0] = 45;
  bits[0] = 256; bits[1] = 128; bits[2] = 64;
  bits[3] = 32; bits[4] = 16; bits[5] = 8;
  bits[6] = 4; bits[7] = 2; bits[8] = 1;
  chars[0] = 'r'; chars[1] = 'w'; chars[2] = 'x';
  chars[3] = 'r'; chars[4] = 'w'; chars[5] = 'x';
  chars[6] = 'r'; chars[7] = 'w'; chars[8] = 'x';
  i = 0;
  while (i < 9) {
    if ((mode & bits[i]) != 0) modebuf[i + 1] = chars[i];
    else modebuf[i + 1] = 45;
    i = i + 1;
  }
  modebuf[10] = 0;
}

void make_path(char *dir, char *name) {
  int i;
  int j;
  i = 0;
  while (dir[i] != 0 && i < 62) {
    fullpath[i] = dir[i];
    i = i + 1;
  }
  if (i == 0 || fullpath[i - 1] != '/') {
    fullpath[i] = '/';
    i = i + 1;
  }
  j = 0;
  while (name[j] != 0 && i < 63) {
    fullpath[i] = name[j];
    i = i + 1;
    j = j + 1;
  }
  fullpath[i] = 0;
}

void print_name(char *name) {
  int j;
  j = 0;
  while (j < 16 && name[j] != 0) {
    write(1, name + j, 1);
    j = j + 1;
  }
}

void print_long(char *dir, char *name) {
  struct stat value;
  int n;
  make_path(dir, name);
  if (lstat(fullpath, &value) < 0) return;
  format_mode(value.mode);
  write(1, modebuf, 10);
  write(1, " ", 1);
  print_int(value.nlink);
  write(1, " ", 1);
  print_int(value.uid);
  write(1, " ", 1);
  print_int(value.gid);
  write(1, " ", 1);
  print_int(value.size);
  write(1, " ", 1);
  print_name(name);
  if ((value.mode & 0xf000) == 0xa000) {
    n = readlink(fullpath, linkbuf, 63);
    if (n >= 0) {
      linkbuf[n] = 0;
      write(1, " -> ", 4);
      write(1, linkbuf, n);
    }
  }
  write(1, "\n", 1);
}

int main(int argc, char **argv) {
  char *path;
  DIR *directory;
  struct dirent *entry;
  int long_format;
  long_format = 0;
  path = "/";
  if (argc >= 2) {
    if (strcmp(argv[1], "-l") == 0) {
      long_format = 1;
      if (argc >= 3) path = argv[2];
    } else {
      path = argv[1];
    }
  }
  directory = opendir(path);
  if (directory == 0) {
    write(2, "ls: cannot open\n", 16);
    return 1;
  }
  entry = readdir(directory);
  while (entry != 0) {
    if (long_format != 0) print_long(path, entry->name);
    else {
      print_name(entry->name);
      write(1, "\n", 1);
    }
    entry = readdir(directory);
  }
  closedir(directory);
  return 0;
}
