// ps: list processes by reading /proc (Phase 27 observability). For each numeric
// /proc/<pid> directory it reads the status file and prints the pid and state.
#include "libc.h"

char path[64];
char buf[256];

int is_number(char *name) {
  int i;
  i = 0;
  if (name[0] == 0) return 0;
  while (name[i] != 0) {
    if (name[i] < '0' || name[i] > '9') return 0;
    i = i + 1;
  }
  return 1;
}

// Find the State letter in a /proc/<pid>/status buffer ("State:\t<X>\n").
int find_state(int n) {
  int i;
  i = 0;
  while (i < n - 7) {
    if (buf[i] == 'S' && buf[i + 1] == 't' && buf[i + 2] == 'a' &&
        buf[i + 3] == 't' && buf[i + 4] == 'e') {
      return buf[i + 7];
    }
    i = i + 1;
  }
  return 63; // '?'
}

int append_str(int at, char *s) {
  int j;
  j = 0;
  while (s[j] != 0 && at < 62) {
    path[at] = s[j];
    at = at + 1;
    j = j + 1;
  }
  return at;
}

void make_status_path(char *pid) {
  int at;
  at = append_str(0, "/proc/");
  at = append_str(at, pid);
  at = append_str(at, "/status");
  path[at] = 0;
}

int main(int argc, char **argv) {
  DIR *directory;
  struct dirent *entry;
  int fd;
  int n;
  write(1, "  PID S\n", 8);
  directory = opendir("/proc");
  if (directory == 0) {
    write(2, "ps: cannot open /proc\n", 22);
    return 1;
  }
  entry = readdir(directory);
  while (entry != 0) {
    if (is_number(entry->name) != 0) {
      make_status_path(entry->name);
      fd = open(path, 0);
      if (fd >= 0) {
        n = read(fd, buf, 256);
        close(fd);
        write(1, "    ", 4);
        printf(entry->name);
        write(1, " ", 1);
        buf[0] = find_state(n);
        write(1, buf, 1);
        write(1, "\n", 1);
      }
    }
    entry = readdir(directory);
  }
  closedir(directory);
  return 0;
}
