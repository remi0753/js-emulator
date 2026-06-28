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

#define FILE_READ 1
#define FILE_WRITE 2
#define FILE_MEMSTREAM 4

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

int poll(struct pollfd *fds, int count, int timeout) {
  return ret_errno(__syscall(CFG_SYS_POLL, fds, count, timeout));
}

int socket(int domain, int type, int protocol) {
  return ret_errno(__syscall(CFG_SYS_SOCKET, domain, type, protocol));
}

int bind(int fd, struct sockaddr_in *address, int length) {
  return ret_errno(__syscall(CFG_SYS_BIND, fd, address, length));
}

int listen(int fd, int backlog) {
  return ret_errno(__syscall(CFG_SYS_LISTEN, fd, backlog, 0));
}

int accept(int fd, struct sockaddr_in *address, int *length) {
  return ret_errno(__syscall(CFG_SYS_ACCEPT, fd, address, length));
}

int connect(int fd, struct sockaddr_in *address, int length) {
  return ret_errno(__syscall(CFG_SYS_CONNECT, fd, address, length));
}

int send(int fd, void *buffer, int length, int flags) {
  if (flags != 0) {
    errno = CFG_EOPNOTSUPP;
    return -1;
  }
  return ret_errno(__syscall(CFG_SYS_SEND, fd, buffer, length));
}

int recv(int fd, void *buffer, int length, int flags) {
  if (flags != 0) {
    errno = CFG_EOPNOTSUPP;
    return -1;
  }
  return ret_errno(__syscall(CFG_SYS_RECV, fd, buffer, length));
}

int sendto(int fd, void *buffer, int length, int flags,
  struct sockaddr_in *address, int address_length) {
  int args[5];
  args[0] = buffer;
  args[1] = length;
  args[2] = flags;
  args[3] = address;
  args[4] = address_length;
  return ret_errno(__syscall(CFG_SYS_SENDTO, fd, args, 0));
}

int recvfrom(int fd, void *buffer, int length, int flags,
  struct sockaddr_in *address, int *address_length) {
  int args[5];
  args[0] = buffer;
  args[1] = length;
  args[2] = flags;
  args[3] = address;
  args[4] = address_length;
  return ret_errno(__syscall(CFG_SYS_RECVFROM, fd, args, 0));
}

int setsockopt(int fd, int level, int option, void *value, int length) {
  int args[4];
  args[0] = level;
  args[1] = option;
  args[2] = value;
  args[3] = length;
  return ret_errno(__syscall(CFG_SYS_SETSOCKOPT, fd, args, 0));
}

int htons(int value) {
  return ((value & 255) << 8) | ((value >> 8) & 255);
}

int ntohs(int value) {
  return htons(value);
}

int htonl(int value) {
  return ((value & 255) << 24) |
    ((value & 0xff00) << 8) |
    ((value >> 8) & 0xff00) |
    ((value >> 24) & 255);
}

int ntohl(int value) {
  return htonl(value);
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

int isspace(int character) {
  return character == ' ' || character == '\t' || character == '\n' ||
    character == '\r' || character == '\v' || character == '\f';
}

int isdigit(int character) {
  return character >= '0' && character <= '9';
}

int isupper(int character) {
  return character >= 'A' && character <= 'Z';
}

int islower(int character) {
  return character >= 'a' && character <= 'z';
}

int isalpha(int character) {
  return isupper(character) || islower(character);
}

int isalnum(int character) {
  return isalpha(character) || isdigit(character);
}

int isxdigit(int character) {
  return isdigit(character) ||
    (character >= 'a' && character <= 'f') ||
    (character >= 'A' && character <= 'F');
}

int toupper(int character) {
  if (islower(character)) return character - 'a' + 'A';
  return character;
}

int tolower(int character) {
  if (isupper(character)) return character - 'A' + 'a';
  return character;
}

int digit_value(int character) {
  if (character >= '0' && character <= '9') return character - '0';
  if (character >= 'a' && character <= 'z') return character - 'a' + 10;
  if (character >= 'A' && character <= 'Z') return character - 'A' + 10;
  return -1;
}

unsigned int strtoul(char *text, char **endptr, int base) {
  int i;
  int sign;
  int digit;
  int digits;
  unsigned int value;
  i = 0;
  sign = 1;
  digits = 0;
  value = 0;
  if (base != 0 && (base < 2 || base > 36)) {
    errno = CFG_EINVAL;
    if (endptr != 0) *endptr = text;
    return 0;
  }
  while (isspace(text[i])) i = i + 1;
  if (text[i] == '+') i = i + 1;
  else if (text[i] == '-') {
    sign = -1;
    i = i + 1;
  }
  if ((base == 0 || base == 16) && text[i] == '0' &&
      (text[i + 1] == 'x' || text[i + 1] == 'X') &&
      digit_value(text[i + 2]) >= 0 && digit_value(text[i + 2]) < 16) {
    base = 16;
    i = i + 2;
  } else if (base == 0 && text[i] == '0') {
    base = 8;
  } else if (base == 0) {
    base = 10;
  }
  while (1) {
    digit = digit_value(text[i]);
    if (digit < 0 || digit >= base) break;
    value = value * base + digit;
    i = i + 1;
    digits = digits + 1;
  }
  if (digits == 0) {
    if (endptr != 0) *endptr = text;
    return 0;
  }
  if (endptr != 0) *endptr = text + i;
  if (sign < 0) return 0 - value;
  return value;
}

int strtol(char *text, char **endptr, int base) {
  return strtoul(text, endptr, base);
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
  stream->mem_buffer = 0;
  stream->mem_size = 0;
  stream->mem_data = 0;
  stream->mem_capacity = 0;
  stream->mem_length = 0;
  stream->mem_position = 0;
  return stream;
}

FILE *fopen(char *path, char *mode) {
  int flags;
  int fd;
  flags = 0;
  if (mode[0] == 'w') flags = O_WRONLY | O_CREAT | O_TRUNC;
  else if (mode[0] == 'a') flags = O_WRONLY | O_CREAT | O_APPEND;
  fd = open(path, flags);
  if (fd < 0) return 0;
  if (mode[0] == 'a') lseek(fd, 0, 2);
  return fdopen(fd, mode);
}

int memstream_grow(FILE *stream, int need) {
  char *next;
  int capacity;
  if (need <= stream->mem_capacity) return 0;
  capacity = stream->mem_capacity;
  if (capacity < 64) capacity = 64;
  while (capacity < need) capacity = capacity * 2;
  next = realloc(stream->mem_data, capacity);
  if (next == 0) {
    stream->error = 1;
    return -1;
  }
  stream->mem_data = next;
  stream->mem_capacity = capacity;
  return 0;
}

void memstream_publish(FILE *stream) {
  if ((stream->flags & FILE_MEMSTREAM) == 0) return;
  if (memstream_grow(stream, stream->mem_length + 1) < 0) return;
  stream->mem_data[stream->mem_length] = 0;
  *stream->mem_buffer = stream->mem_data;
  *stream->mem_size = stream->mem_length;
}

FILE *open_memstream(char **buffer, size_t *size) {
  FILE *stream;
  if (buffer == 0 || size == 0) return 0;
  stream = fdopen(-1, "w");
  if (stream == 0) return 0;
  stream->flags = FILE_WRITE | FILE_MEMSTREAM;
  stream->mem_buffer = buffer;
  stream->mem_size = size;
  stream->mem_capacity = 0;
  stream->mem_length = 0;
  stream->mem_position = 0;
  stream->mem_data = 0;
  *buffer = 0;
  *size = 0;
  if (memstream_grow(stream, 1) < 0) {
    free(stream);
    return 0;
  }
  memstream_publish(stream);
  return stream;
}

int fclose(FILE *stream) {
  int result;
  if (stream == 0) return -1;
  if ((stream->flags & FILE_MEMSTREAM) != 0) {
    memstream_publish(stream);
    free(stream);
    return 0;
  }
  result = close(stream->fd);
  if (stream != stdin && stream != stdout && stream != stderr) free(stream);
  return result;
}

int fflush(FILE *stream) {
  if (stream != 0) memstream_publish(stream);
  return 0;
}

int fseek(FILE *stream, int offset, int whence) {
  int result;
  if ((stream->flags & FILE_MEMSTREAM) != 0) {
    if (whence == SEEK_SET) result = offset;
    else if (whence == SEEK_CUR) result = stream->mem_position + offset;
    else if (whence == SEEK_END) result = stream->mem_length + offset;
    else result = -1;
    if (result < 0) {
      stream->error = 1;
      return -1;
    }
    stream->mem_position = result;
    stream->eof = 0;
    return 0;
  }
  result = lseek(stream->fd, offset, whence);
  if (result < 0) {
    stream->error = 1;
    return -1;
  }
  stream->eof = 0;
  return 0;
}

int ftell(FILE *stream) {
  int result;
  if ((stream->flags & FILE_MEMSTREAM) != 0) return stream->mem_position;
  result = lseek(stream->fd, 0, 1);
  if (result < 0) stream->error = 1;
  return result;
}

int feof(FILE *stream) {
  return stream->eof;
}

int ferror(FILE *stream) {
  return stream->error;
}

void clearerr(FILE *stream) {
  stream->error = 0;
  stream->eof = 0;
}

int fileno(FILE *stream) {
  return stream->fd;
}

int fread(void *buffer, int size, int count, FILE *stream) {
  char *bytes;
  int total;
  int done;
  int n;
  if (size <= 0 || count <= 0) return 0;
  if ((stream->flags & FILE_MEMSTREAM) != 0) {
    bytes = buffer;
    total = size * count;
    if (stream->mem_position >= stream->mem_length) {
      stream->eof = 1;
      return 0;
    }
    if (total > stream->mem_length - stream->mem_position) {
      total = stream->mem_length - stream->mem_position;
      stream->eof = 1;
    }
    memcpy(bytes, stream->mem_data + stream->mem_position, total);
    stream->mem_position = stream->mem_position + total;
    return total / size;
  }
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
  if ((stream->flags & FILE_MEMSTREAM) != 0) {
    if (memstream_grow(stream, stream->mem_position + total + 1) < 0) return 0;
    memcpy(stream->mem_data + stream->mem_position, bytes, total);
    stream->mem_position = stream->mem_position + total;
    if (stream->mem_position > stream->mem_length) stream->mem_length = stream->mem_position;
    memstream_publish(stream);
    return count;
  }
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
  int n;
  n = read(stream->fd, &c, 1);
  if (n == 1) return c;
  if (n == 0) {
    stream->eof = 1;
    return -1;
  }
  stream->error = 1;
  return -1;
}

int fputc(int character, FILE *stream) {
  char c;
  c = character;
  if ((stream->flags & FILE_MEMSTREAM) != 0) {
    if (fwrite(&c, 1, 1, stream) != 1) return -1;
    return c;
  }
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

struct format_sink {
  FILE *stream;
  char *buffer;
  int size;
  int count;
  int error;
};

void format_putc(struct format_sink *sink, int character) {
  if (sink->stream != 0) {
    if (fputc(character, sink->stream) < 0) sink->error = 1;
  } else if (sink->buffer != 0 && sink->size > 0 &&
      sink->count + 1 < sink->size) {
    sink->buffer[sink->count] = character;
  }
  sink->count = sink->count + 1;
}

void format_puts(struct format_sink *sink, char *text) {
  int i;
  if (text == 0) text = "(null)";
  i = 0;
  while (text[i] != 0) {
    format_putc(sink, text[i]);
    i = i + 1;
  }
}

void format_uint(struct format_sink *sink, unsigned int value, int base, int upper) {
  char digits[32];
  int n;
  int digit;
  if (value == 0) {
    format_putc(sink, '0');
    return;
  }
  n = 0;
  while (value != 0) {
    digit = value % base;
    if (digit < 10) digits[n] = '0' + digit;
    else if (upper != 0) digits[n] = 'A' + digit - 10;
    else digits[n] = 'a' + digit - 10;
    value = value / base;
    n = n + 1;
  }
  while (n > 0) {
    n = n - 1;
    format_putc(sink, digits[n]);
  }
}

void format_ull(struct format_sink *sink, unsigned long long value, int base, int upper) {
  char digits[64];
  int n;
  int digit;
  if (value == 0ull) {
    format_putc(sink, '0');
    return;
  }
  n = 0;
  while (value != 0ull) {
    digit = value % base;
    if (digit < 10) digits[n] = '0' + digit;
    else if (upper != 0) digits[n] = 'A' + digit - 10;
    else digits[n] = 'a' + digit - 10;
    value = value / base;
    n = n + 1;
  }
  while (n > 0) {
    n = n - 1;
    format_putc(sink, digits[n]);
  }
}

void format_int(struct format_sink *sink, int value) {
  if (value < 0) {
    format_putc(sink, '-');
    format_uint(sink, 0 - value, 10, 0);
  } else {
    format_uint(sink, value, 10, 0);
  }
}

void format_ll(struct format_sink *sink, long long value) {
  unsigned long long magnitude;
  if (value < 0ll) {
    format_putc(sink, '-');
    magnitude = 0ull - (unsigned long long)value;
    format_ull(sink, magnitude, 10, 0);
  } else {
    format_ull(sink, value, 10, 0);
  }
}

int vformat(struct format_sink *sink, char *format, va_list ap) {
  int i;
  int long_flag;
  int spec;
  i = 0;
  while (format[i] != 0) {
    if (format[i] != '%') {
      format_putc(sink, format[i]);
      i = i + 1;
      continue;
    }
    i = i + 1;
    if (format[i] == '%') {
      format_putc(sink, '%');
      i = i + 1;
      continue;
    }
    long_flag = 0;
    if (format[i] == 'l') {
      long_flag = 1;
      i = i + 1;
      if (format[i] == 'l') {
        long_flag = 2;
        i = i + 1;
      }
    }
    spec = format[i];
    if (spec == 0) break;
    if (spec == 's') format_puts(sink, va_arg(ap, char *));
    else if (spec == 'c') format_putc(sink, va_arg(ap, int));
    else if (spec == 'd' || spec == 'i') {
      if (long_flag == 2) format_ll(sink, va_arg(ap, long long));
      else format_int(sink, va_arg(ap, int));
    } else if (spec == 'u') {
      if (long_flag == 2) format_ull(sink, va_arg(ap, unsigned long long), 10, 0);
      else format_uint(sink, va_arg(ap, unsigned int), 10, 0);
    } else if (spec == 'x') {
      if (long_flag == 2) format_ull(sink, va_arg(ap, unsigned long long), 16, 0);
      else format_uint(sink, va_arg(ap, unsigned int), 16, 0);
    } else if (spec == 'X') {
      if (long_flag == 2) format_ull(sink, va_arg(ap, unsigned long long), 16, 1);
      else format_uint(sink, va_arg(ap, unsigned int), 16, 1);
    }
    else if (spec == 'p') {
      format_puts(sink, "0x");
      format_uint(sink, va_arg(ap, unsigned int), 16, 0);
    } else {
      format_putc(sink, '%');
      if (long_flag != 0) format_putc(sink, 'l');
      format_putc(sink, spec);
    }
    i = i + 1;
  }
  if (sink->buffer != 0 && sink->size > 0) {
    if (sink->count < sink->size) sink->buffer[sink->count] = 0;
    else sink->buffer[sink->size - 1] = 0;
  }
  if (sink->error != 0) return -1;
  return sink->count;
}

int vfprintf(FILE *stream, char *format, va_list ap) {
  struct format_sink sink;
  sink.stream = stream;
  sink.buffer = 0;
  sink.size = 0;
  sink.count = 0;
  sink.error = 0;
  return vformat(&sink, format, ap);
}

int vsnprintf(char *buffer, int size, char *format, va_list ap) {
  struct format_sink sink;
  sink.stream = 0;
  sink.buffer = buffer;
  sink.size = size;
  sink.count = 0;
  sink.error = 0;
  return vformat(&sink, format, ap);
}

int snprintf(char *buffer, int size, char *format, ...) {
  va_list ap;
  int result;
  va_start(ap, format);
  result = vsnprintf(buffer, size, format, ap);
  va_end(ap);
  return result;
}

int printf(char *format, ...) {
  va_list ap;
  int result;
  struct format_sink sink;
  sink.stream = stdout;
  sink.buffer = 0;
  sink.size = 0;
  sink.count = 0;
  sink.error = 0;
  va_start(ap, format);
  result = vformat(&sink, format, ap);
  va_end(ap);
  return result;
}

int fprintf(FILE *stream, char *format, ...) {
  va_list ap;
  int result;
  struct format_sink sink;
  sink.stream = stream;
  sink.buffer = 0;
  sink.size = 0;
  sink.count = 0;
  sink.error = 0;
  va_start(ap, format);
  result = vformat(&sink, format, ap);
  va_end(ap);
  return result;
}

int print_int(int value) {
  return printf("%d", value);
}

char tmpnam_buffer[32];
int tmp_sequence;

char *tmpnam(char *buffer) {
  char *out;
  out = buffer;
  if (out == 0) out = tmpnam_buffer;
  tmp_sequence = tmp_sequence + 1;
  snprintf(out, 32, "/tmp/ctmp%x", tmp_sequence);
  return out;
}

int mkstemp(char *template) {
  int i;
  int j;
  int n;
  int value;
  int fd;
  struct stat st;
  char *digits;
  digits = "0123456789abcdefghijklmnopqrstuvwxyz";
  n = strlen(template);
  if (n < 6) {
    errno = CFG_EINVAL;
    return -1;
  }
  j = n - 6;
  while (j < n) {
    if (template[j] != 'X') {
      errno = CFG_EINVAL;
      return -1;
    }
    j = j + 1;
  }
  i = 0;
  while (i < 256) {
    tmp_sequence = tmp_sequence + 1;
    value = tmp_sequence;
    j = n - 1;
    while (j >= n - 6) {
      template[j] = digits[value % 36];
      value = value / 36;
      j = j - 1;
    }
    if (stat(template, &st) == 0) {
      i = i + 1;
      continue;
    }
    if (errno != CFG_ENOENT) return -1;
    fd = open(template, O_RDWR | O_CREAT);
    if (fd >= 0) return fd;
    if (errno != CFG_EEXIST) return -1;
    i = i + 1;
  }
  errno = CFG_EEXIST;
  return -1;
}

FILE *tmpfile(void) {
  char path[32];
  int fd;
  strcpy(path, "/tmp/ctmpXXXXXX");
  fd = mkstemp(path);
  if (fd < 0) return 0;
  unlink(path);
  return fdopen(fd, "w+");
}

int remove(char *path) {
  return unlink(path);
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
