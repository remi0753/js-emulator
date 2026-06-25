#include "libc.h"

int main(int argc, char **argv) {
  DIR *directory;
  struct dirent *entry;
  FILE *file;
  char buffer[8];
  int found;
  if (strcmp(basename("/tmp/check"), "check") != 0) return 1;
  if (strcmp(dirname("/tmp/check"), "/tmp") != 0) return 2;
  if (setenv("LIBC_TEST", "ok", 1) < 0) return 3;
  if (strcmp(getenv("LIBC_TEST"), "ok") != 0) return 4;
  file = fopen("/tmp/libc-test", "w");
  if (file == 0) return 5;
  if (fputs("hello\n", file) < 0) return 6;
  fclose(file);
  file = fopen("/tmp/libc-test", "r");
  if (file == 0) return 7;
  if (fgets(buffer, 8, file) == 0) return 8;
  fclose(file);
  if (strcmp(buffer, "hello\n") != 0) return 9;
  directory = opendir("/tmp");
  if (directory == 0) return 10;
  found = 0;
  entry = readdir(directory);
  while (entry != 0) {
    if (strcmp(entry->name, "libc-test") == 0) found = 1;
    entry = readdir(directory);
  }
  closedir(directory);
  unlink("/tmp/libc-test");
  if (found == 0) return 11;
  puts("libc-tests: ok");
  return 0;
}
