// libc for custom32 userland. It provides the syscall boundary plus the small,
// coherent C/POSIX surface used by the maintained shell and utilities.
//
// The syscall-number tokens are substituted by ../guest-kernel.ts so the numbers
// stay a single source of truth shared with the kernel.

#include "libc.h"

struct mmap_args {
  int address;
  int length;
  int protection;
  int flags;
  int fd;
  int offset;
};

int errno;

FILE stdin_object = {0, 1, 0, 0};
FILE stdout_object = {1, 2, 0, 0};
FILE stderr_object = {2, 2, 0, 0};
FILE *stdin = &stdin_object;
FILE *stdout = &stdout_object;
FILE *stderr = &stderr_object;
char minus_text[2] = {45, 0};

sighandler_t signal_handlers[32];
int signal_current;

// The kernel enters caught handlers with the signal number in R0. This common
// dispatcher moves it into normal C calling-convention storage, invokes the
// application handler, then RETs to signal_restorer on the user hardware stack.
void signal_dispatch() {
  asm("STORE R0, signal_current\n");
  signal_handlers[signal_current](signal_current);
}

void signal_restorer() {
  __syscall(CFG_SYS_SIGRETURN, 0, 0, 0);
}

// Translate a raw syscall result into the classic libc convention: a negative
// kernel return is an errno, reported as errno + a -1 return; a non-negative
// result passes through unchanged.
int ret_errno(int r) {
  if (r < 0) {
    errno = 0 - r;
    return -1;
  }
  return r;
}

int write(int fd, char *buf, int n) {
  return ret_errno(__syscall(CFG_SYS_WRITE, fd, buf, n));
}

int read(int fd, char *buf, int n) {
  return ret_errno(__syscall(CFG_SYS_READ, fd, buf, n));
}

int open(char *path, int flags) {
  return ret_errno(__syscall(CFG_SYS_OPEN, path, flags, 0));
}

int close(int fd) {
  return ret_errno(__syscall(CFG_SYS_CLOSE, fd, 0, 0));
}

int fork() {
  return ret_errno(__syscall(CFG_SYS_FORK, 0, 0, 0));
}

int wait() {
  return ret_errno(__syscall(CFG_SYS_WAIT, 0, 0, 0));
}

int waitpid(int pid, int *status, int options) {
  return ret_errno(__syscall(CFG_SYS_WAITPID, pid, status, options));
}

int exec(char *path, char **argv) {
  return ret_errno(__syscall(CFG_SYS_EXEC, path, argv, environ));
}

int execve(char *path, char **argv, char **envp) {
  return ret_errno(__syscall(CFG_SYS_EXEC, path, argv, envp));
}

int getpid() {
  return ret_errno(__syscall(CFG_SYS_GETPID, 0, 0, 0));
}

int getppid() {
  return ret_errno(__syscall(CFG_SYS_GETPPID, 0, 0, 0));
}

int kill(int pid, int sig) {
  return ret_errno(__syscall(CFG_SYS_KILL, pid, sig, 0));
}

int sigaction(int sig, struct sigaction *action, struct sigaction *old_action) {
  struct sigaction kernel_action;
  struct sigaction kernel_old;
  struct sigaction *kernel_action_ptr;
  struct sigaction *kernel_old_ptr;
  sighandler_t previous_handler;
  sighandler_t next_handler;
  int result;
  previous_handler = 0;
  if (sig >= 0 && sig < 32) {
    previous_handler = signal_handlers[sig];
  }
  next_handler = previous_handler;
  kernel_action_ptr = 0;
  kernel_old_ptr = 0;
  if (action != 0) {
    kernel_action.mask = action->mask;
    kernel_action.flags = action->flags;
    kernel_action.restorer = signal_restorer;
    if (action->handler == 0 || action->handler == 1) {
      kernel_action.handler = action->handler;
      next_handler = action->handler;
    } else {
      next_handler = action->handler;
      kernel_action.handler = signal_dispatch;
    }
    kernel_action_ptr = &kernel_action;
  }
  if (old_action != 0) {
    kernel_old_ptr = &kernel_old;
  }
  result = ret_errno(
    __syscall(CFG_SYS_SIGACTION, sig, kernel_action_ptr, kernel_old_ptr));
  if (result == 0 && old_action != 0) {
    old_action->mask = kernel_old.mask;
    old_action->flags = kernel_old.flags;
    old_action->restorer = 0;
    if (kernel_old.handler == signal_dispatch) {
      old_action->handler = previous_handler;
    } else {
      old_action->handler = kernel_old.handler;
    }
  }
  if (result == 0 && action != 0) {
    signal_handlers[sig] = next_handler;
  }
  return result;
}

int signal(int sig, sighandler_t handler) {
  struct sigaction action;
  struct sigaction old_action;
  action.handler = handler;
  action.mask = 0;
  action.flags = 0;
  action.restorer = 0;
  if (sigaction(sig, &action, &old_action) < 0) {
    return -1;
  }
  return old_action.handler;
}

int sigprocmask(int how, int mask, int *old_mask) {
  return ret_errno(__syscall(CFG_SYS_SIGPROCMASK, how, mask, old_mask));
}

int setpgid(int pid, int pgid) {
  return ret_errno(__syscall(CFG_SYS_SETPGID, pid, pgid, 0));
}

int setsid() {
  return ret_errno(__syscall(CFG_SYS_SETSID, 0, 0, 0));
}

int tcsetpgrp(int pgid) {
  return ret_errno(__syscall(CFG_SYS_TCSETPGRP, pgid, 0, 0));
}

int tcgetpgrp() {
  return ret_errno(__syscall(CFG_SYS_TCGETPGRP, 0, 0, 0));
}

int pipe(int *fds) {
  return ret_errno(__syscall(CFG_SYS_PIPE, fds, 0, 0));
}

int dup(int fd) {
  return ret_errno(__syscall(CFG_SYS_DUP, fd, 0, 0));
}

int fcntl(int fd, int command, int argument) {
  return ret_errno(__syscall(CFG_SYS_FCNTL, fd, command, argument));
}

int ioctl(int fd, int request, int argument) {
  return ret_errno(__syscall(CFG_SYS_IOCTL, fd, request, argument));
}

int tcgetattr(int fd, struct termios *attributes) {
  return ioctl(fd, CFG_TCGETS, attributes);
}

int tcsetattr(int fd, int actions, struct termios *attributes) {
  int request;
  request = CFG_TCSETS;
  if (actions == 1) request = CFG_TCSETSW;
  else if (actions == 2) request = CFG_TCSETSF;
  return ioctl(fd, request, attributes);
}

int tcgetwinsize(int fd, struct winsize *size) {
  return ioctl(fd, CFG_TIOCGWINSZ, size);
}

int tcsetwinsize(int fd, struct winsize *size) {
  return ioctl(fd, CFG_TIOCSWINSZ, size);
}

int isatty(int fd) {
  struct termios attributes;
  return tcgetattr(fd, &attributes) == 0;
}

int nanosleep(struct timespec *request, struct timespec *remaining) {
  return ret_errno(__syscall(CFG_SYS_NANOSLEEP, request, remaining, 0));
}

int brk(void *address) {
  int result;
  result = ret_errno(__syscall(CFG_SYS_BRK, address, 0, 0));
  if (result < 0) {
    return -1;
  }
  return 0;
}

void *sbrk(int increment) {
  int old_break;
  int new_break;
  old_break = ret_errno(__syscall(CFG_SYS_BRK, 0, 0, 0));
  if (old_break < 0) {
    return -1;
  }
  new_break = ret_errno(
    __syscall(CFG_SYS_BRK, old_break + increment, 0, 0));
  if (new_break < 0) {
    return -1;
  }
  return old_break;
}

void *mmap(void *address, int length, int protection, int flags, int fd, int offset) {
  struct mmap_args arguments;
  int result;
  arguments.address = address;
  arguments.length = length;
  arguments.protection = protection;
  arguments.flags = flags;
  arguments.fd = fd;
  arguments.offset = offset;
  result = ret_errno(__syscall(CFG_SYS_MMAP, &arguments, 0, 0));
  if (result < 0) {
    return -1;
  }
  return result;
}

int munmap(void *address, int length) {
  return ret_errno(__syscall(CFG_SYS_MUNMAP, address, length, 0));
}

int mprotect(void *address, int length, int protection) {
  return ret_errno(__syscall(CFG_SYS_MPROTECT, address, length, protection));
}

struct heap_block {
  int size;
  int free;
  int next;
};

int heap_blocks;

void *malloc(int size) {
  struct heap_block *block;
  int total;
  if (size <= 0) return 0;
  size = (size + 7) & 0xfffffff8;
  block = heap_blocks;
  while (block != 0) {
    if (block->free != 0 && block->size >= size) {
      block->free = 0;
      return block + 1;
    }
    block = block->next;
  }
  total = size + sizeof(struct heap_block);
  block = sbrk(total);
  if (block == -1) return 0;
  block->size = size;
  block->free = 0;
  block->next = heap_blocks;
  heap_blocks = block;
  return block + 1;
}

void free(void *pointer) {
  struct heap_block *block;
  if (pointer != 0) {
    block = pointer;
    block = block - 1;
    block->free = 1;
  }
}

void *calloc(int count, int size) {
  void *pointer;
  int total;
  if (count <= 0 || size <= 0) return 0;
  total = count * size;
  if (total / count != size) return 0;
  pointer = malloc(total);
  if (pointer != 0) memset(pointer, 0, total);
  return pointer;
}

void *realloc(void *pointer, int size) {
  struct heap_block *old_block;
  void *next;
  int copy;
  if (pointer == 0) return malloc(size);
  if (size <= 0) {
    free(pointer);
    return 0;
  }
  old_block = pointer;
  old_block = old_block - 1;
  if (old_block->size >= size) return pointer;
  next = malloc(size);
  if (next == 0) return 0;
  copy = old_block->size;
  if (copy > size) copy = size;
  memcpy(next, pointer, copy);
  free(pointer);
  return next;
}

int gettimeofday(struct timeval *value, void *timezone) {
  return ret_errno(__syscall(CFG_SYS_GETTIMEOFDAY, value, timezone, 0));
}

int clock_gettime(int clock_id, struct timespec *value) {
  return ret_errno(__syscall(CFG_SYS_CLOCK_GETTIME, clock_id, value, 0));
}

int uname(struct utsname *name) {
  return ret_errno(__syscall(CFG_SYS_UNAME, name, 0, 0));
}

int getdents(int fd, struct dirent *entries, int count) {
  return ret_errno(__syscall(CFG_SYS_GETDENTS, fd, entries, count));
}

int stat(char *path, struct stat *value) {
  return ret_errno(__syscall(CFG_SYS_STAT, path, value, 0));
}

int fstat(int fd, struct stat *value) {
  return ret_errno(__syscall(CFG_SYS_FSTAT, fd, value, 0));
}

int lstat(char *path, struct stat *value) {
  return ret_errno(__syscall(CFG_SYS_LSTAT, path, value, 0));
}

int chmod(char *path, int mode) {
  return ret_errno(__syscall(CFG_SYS_CHMOD, path, mode, 0));
}

int chown(char *path, int uid, int gid) {
  return ret_errno(__syscall(CFG_SYS_CHOWN, path, uid, gid));
}

int mkdir(char *path, int mode) {
  return ret_errno(__syscall(CFG_SYS_MKDIR, path, mode, 0));
}

int rmdir(char *path) {
  return ret_errno(__syscall(CFG_SYS_RMDIR, path, 0, 0));
}

int unlink(char *path) {
  return ret_errno(__syscall(CFG_SYS_UNLINK, path, 0, 0));
}

int link(char *oldpath, char *newpath) {
  return ret_errno(__syscall(CFG_SYS_LINK, oldpath, newpath, 0));
}

int rename(char *oldpath, char *newpath) {
  return ret_errno(__syscall(CFG_SYS_RENAME, oldpath, newpath, 0));
}

int symlink(char *target, char *linkpath) {
  return ret_errno(__syscall(CFG_SYS_SYMLINK, target, linkpath, 0));
}

int readlink(char *path, char *buffer, int size) {
  return ret_errno(__syscall(CFG_SYS_READLINK, path, buffer, size));
}

int lseek(int fd, int offset, int whence) {
  return ret_errno(__syscall(CFG_SYS_LSEEK, fd, offset, whence));
}

int getuid() {
  return ret_errno(__syscall(CFG_SYS_GETUID, 0, 0, 0));
}

int getgid() {
  return ret_errno(__syscall(CFG_SYS_GETGID, 0, 0, 0));
}

void exit(int code) {
  __syscall(CFG_SYS_EXIT, code, 0, 0);
}

// Current wall-clock time in whole seconds (Unix epoch), from the RTC device.
int time() {
  return ret_errno(__syscall(CFG_SYS_TIME, 0, 0, 0));
}

// Power the machine off cleanly. Does not return.
void shutdown() {
  __syscall(CFG_SYS_SHUTDOWN, 0, 0, 0);
}

// --- strings and memory ----------------------------------------------------

void *memmove(void *destination, void *source, int length) {
  char *d;
  char *s;
  int i;
  d = destination;
  s = source;
  if (d < s) return memcpy(destination, source, length);
  i = length - 1;
  while (i >= 0) {
    d[i] = s[i];
    i = i - 1;
  }
  return destination;
}

int memcmp(void *left, void *right, int length) {
  char *a;
  char *b;
  int i;
  a = left;
  b = right;
  i = 0;
  while (i < length) {
    if (a[i] != b[i]) return a[i] - b[i];
    i = i + 1;
  }
  return 0;
}

int strncmp(char *left, char *right, int length) {
  int i;
  i = 0;
  while (i < length) {
    if (left[i] != right[i]) return left[i] - right[i];
    if (left[i] == 0) return 0;
    i = i + 1;
  }
  return 0;
}

char *strcpy(char *destination, char *source) {
  int i;
  i = 0;
  while (source[i] != 0) {
    destination[i] = source[i];
    i = i + 1;
  }
  destination[i] = 0;
  return destination;
}

char *strncpy(char *destination, char *source, int length) {
  int i;
  i = 0;
  while (i < length && source[i] != 0) {
    destination[i] = source[i];
    i = i + 1;
  }
  while (i < length) {
    destination[i] = 0;
    i = i + 1;
  }
  return destination;
}

char *strcat(char *destination, char *source) {
  int at;
  int i;
  at = strlen(destination);
  i = 0;
  while (source[i] != 0) {
    destination[at + i] = source[i];
    i = i + 1;
  }
  destination[at + i] = 0;
  return destination;
}

char *strchr(char *text, int character) {
  int i;
  i = 0;
  while (text[i] != 0) {
    if (text[i] == character) return text + i;
    i = i + 1;
  }
  if (character == 0) return text + i;
  return 0;
}

char *strrchr(char *text, int character) {
  char *found;
  int i;
  found = 0;
  i = 0;
  while (text[i] != 0) {
    if (text[i] == character) found = text + i;
    i = i + 1;
  }
  if (character == 0) return text + i;
  return found;
}

char *strstr(char *text, char *needle) {
  int i;
  int length;
  length = strlen(needle);
  if (length == 0) return text;
  i = 0;
  while (text[i] != 0) {
    if (strncmp(text + i, needle, length) == 0) return text + i;
    i = i + 1;
  }
  return 0;
}

char *strdup(char *text) {
  char *copy;
  copy = malloc(strlen(text) + 1);
  if (copy != 0) strcpy(copy, text);
  return copy;
}

int atoi(char *text) {
  int sign;
  int value;
  int i;
  sign = 1;
  value = 0;
  i = 0;
  if (text[0] == 45) {
    sign = -1;
    i = 1;
  }
  while (text[i] >= '0' && text[i] <= '9') {
    value = value * 10 + text[i] - '0';
    i = i + 1;
  }
  return value * sign;
}

// --- unbuffered stdio ------------------------------------------------------

FILE *fdopen(int fd, char *mode) {
  FILE *stream;
  stream = malloc(sizeof(FILE));
  if (stream == 0) return 0;
  stream->fd = fd;
  stream->flags = 0;
  if (mode[0] == 'r') stream->flags = 1;
  else stream->flags = 2;
  stream->error = 0;
  stream->eof = 0;
  return stream;
}

FILE *fopen(char *path, char *mode) {
  int flags;
  int fd;
  flags = 0;
  if (mode[0] == 'w') flags = 0x601;
  else if (mode[0] == 'a') flags = 0x201;
  fd = open(path, flags);
  if (fd < 0) return 0;
  if (mode[0] == 'a') lseek(fd, 0, 2);
  return fdopen(fd, mode);
}

int fclose(FILE *stream) {
  int result;
  if (stream == 0) return -1;
  result = close(stream->fd);
  if (stream != stdin && stream != stdout && stream != stderr) free(stream);
  return result;
}

int fflush(FILE *stream) {
  return 0;
}

int fread(void *buffer, int size, int count, FILE *stream) {
  char *bytes;
  int total;
  int done;
  int n;
  if (size <= 0 || count <= 0) return 0;
  bytes = buffer;
  total = size * count;
  done = 0;
  while (done < total) {
    n = read(stream->fd, bytes + done, total - done);
    if (n < 0) {
      stream->error = 1;
      break;
    }
    if (n == 0) {
      stream->eof = 1;
      break;
    }
    done = done + n;
  }
  return done / size;
}

int fwrite(void *buffer, int size, int count, FILE *stream) {
  char *bytes;
  int total;
  int done;
  int n;
  if (size <= 0 || count <= 0) return 0;
  bytes = buffer;
  total = size * count;
  done = 0;
  while (done < total) {
    n = write(stream->fd, bytes + done, total - done);
    if (n <= 0) {
      stream->error = 1;
      break;
    }
    done = done + n;
  }
  return done / size;
}

int fgetc(FILE *stream) {
  char c;
  if (read(stream->fd, &c, 1) != 1) {
    stream->eof = 1;
    return -1;
  }
  return c;
}

int fputc(int character, FILE *stream) {
  char c;
  c = character;
  if (write(stream->fd, &c, 1) != 1) {
    stream->error = 1;
    return -1;
  }
  return c;
}

char *fgets(char *buffer, int size, FILE *stream) {
  int i;
  int c;
  if (size <= 0) return 0;
  i = 0;
  while (i + 1 < size) {
    c = fgetc(stream);
    if (c < 0) break;
    buffer[i] = c;
    i = i + 1;
    if (c == '\n') break;
  }
  buffer[i] = 0;
  if (i == 0) return 0;
  return buffer;
}

int fputs(char *text, FILE *stream) {
  int length;
  length = strlen(text);
  if (fwrite(text, 1, length, stream) != length) return -1;
  return 0;
}

int puts(char *text) {
  if (fputs(text, stdout) < 0) return -1;
  return fputc('\n', stdout);
}

int printf(char *text) {
  return fputs(text, stdout);
}

int fprintf(FILE *stream, char *text) {
  return fputs(text, stream);
}

int print_int(int value) {
  char digits[16];
  int i;
  int start;
  if (value == 0) return write(1, "0", 1);
  if (value < 0) {
    write(1, minus_text, 1);
    value = 0 - value;
  }
  i = 0;
  while (value > 0) {
    digits[i] = '0' + value % 10;
    value = value / 10;
    i = i + 1;
  }
  start = i - 1;
  while (start >= 0) {
    write(1, digits + start, 1);
    start = start - 1;
  }
  return i;
}

// --- directories -----------------------------------------------------------

DIR *opendir(char *path) {
  DIR *directory;
  int fd;
  fd = open(path, 0);
  if (fd < 0) return 0;
  directory = malloc(sizeof(DIR));
  if (directory == 0) {
    close(fd);
    return 0;
  }
  directory->fd = fd;
  directory->next = 0;
  directory->count = 0;
  return directory;
}

struct dirent *readdir(DIR *directory) {
  int bytes;
  if (directory->next >= directory->count) {
    bytes = getdents(directory->fd, directory->entries,
      sizeof(struct dirent) * 4);
    if (bytes <= 0) return 0;
    directory->count = bytes / sizeof(struct dirent);
    directory->next = 0;
  }
  directory->next = directory->next + 1;
  return &directory->entries[directory->next - 1];
}

void rewinddir(DIR *directory) {
  lseek(directory->fd, 0, 0);
  directory->next = 0;
  directory->count = 0;
}

int closedir(DIR *directory) {
  int result;
  result = close(directory->fd);
  free(directory);
  return result;
}

// --- environment -----------------------------------------------------------

int env_name_length(char *entry) {
  int i;
  i = 0;
  while (entry[i] != 0 && entry[i] != '=') i = i + 1;
  return i;
}

int env_count(void) {
  int count;
  count = 0;
  if (environ == 0) return 0;
  while (environ[count] != 0) count = count + 1;
  return count;
}

char *getenv(char *name) {
  int i;
  int length;
  length = strlen(name);
  i = 0;
  while (environ != 0 && environ[i] != 0) {
    if (env_name_length(environ[i]) == length &&
        strncmp(environ[i], name, length) == 0) {
      return environ[i] + length + 1;
    }
    i = i + 1;
  }
  return 0;
}

int putenv(char *entry) {
  char **next;
  int count;
  int i;
  int name_length;
  int replace;
  count = env_count();
  name_length = env_name_length(entry);
  replace = -1;
  i = 0;
  while (i < count) {
    if (env_name_length(environ[i]) == name_length &&
        strncmp(environ[i], entry, name_length) == 0) {
      replace = i;
    }
    i = i + 1;
  }
  next = malloc((count + 2) * 4);
  if (next == 0) return -1;
  i = 0;
  while (i < count) {
    next[i] = environ[i];
    i = i + 1;
  }
  if (replace >= 0) next[replace] = entry;
  else {
    next[count] = entry;
    count = count + 1;
  }
  next[count] = 0;
  environ = next;
  return 0;
}

int setenv(char *name, char *value, int overwrite) {
  char *entry;
  int name_length;
  int value_length;
  if (strchr(name, '=') != 0 || name[0] == 0) {
    errno = 22;
    return -1;
  }
  if (overwrite == 0 && getenv(name) != 0) return 0;
  name_length = strlen(name);
  value_length = strlen(value);
  entry = malloc(name_length + value_length + 2);
  if (entry == 0) return -1;
  strcpy(entry, name);
  entry[name_length] = '=';
  strcpy(entry + name_length + 1, value);
  return putenv(entry);
}

int unsetenv(char *name) {
  char **next;
  int count;
  int length;
  int i;
  int out;
  count = env_count();
  length = strlen(name);
  next = malloc((count + 1) * 4);
  if (next == 0) return -1;
  i = 0;
  out = 0;
  while (i < count) {
    if (env_name_length(environ[i]) != length ||
        strncmp(environ[i], name, length) != 0) {
      next[out] = environ[i];
      out = out + 1;
    }
    i = i + 1;
  }
  next[out] = 0;
  environ = next;
  return 0;
}

// --- path and time helpers -------------------------------------------------

char basename_buffer[128];
char dirname_buffer[128];

char *basename(char *path) {
  int end;
  int start;
  int out;
  end = strlen(path);
  while (end > 1 && path[end - 1] == '/') end = end - 1;
  start = end;
  while (start > 0 && path[start - 1] != '/') start = start - 1;
  out = 0;
  while (start < end && out < 127) {
    basename_buffer[out] = path[start];
    start = start + 1;
    out = out + 1;
  }
  basename_buffer[out] = 0;
  return basename_buffer;
}

char *dirname(char *path) {
  int end;
  int out;
  end = strlen(path);
  while (end > 1 && path[end - 1] == '/') end = end - 1;
  while (end > 0 && path[end - 1] != '/') end = end - 1;
  while (end > 1 && path[end - 1] == '/') end = end - 1;
  if (end == 0) {
    dirname_buffer[0] = '.';
    dirname_buffer[1] = 0;
    return dirname_buffer;
  }
  out = 0;
  while (out < end && out < 127) {
    dirname_buffer[out] = path[out];
    out = out + 1;
  }
  dirname_buffer[out] = 0;
  return dirname_buffer;
}

int path_join(char *output, int size, char *left, char *right) {
  int at;
  int i;
  if (strlen(left) + strlen(right) + 2 > size) {
    errno = 36;
    return -1;
  }
  strcpy(output, left);
  at = strlen(output);
  if (at > 0 && output[at - 1] != '/') {
    output[at] = '/';
    at = at + 1;
  }
  i = 0;
  while (right[i] == '/') i = i + 1;
  strcpy(output + at, right + i);
  return 0;
}

int sleep(int seconds) {
  struct timespec request;
  request.tv_sec = seconds;
  request.tv_nsec = 0;
  if (nanosleep(&request, 0) < 0) return -1;
  return 0;
}
