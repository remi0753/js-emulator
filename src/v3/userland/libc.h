// Public C library interface for custom32 user programs. The guest compiler's
// include pass deduplicates this file, so traditional preprocessor guards are
// unnecessary.

extern int errno;
extern char **environ;

#define NULL ((void *)0)
#define EOF (-1)

#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2

#define O_RDONLY 0
#define O_WRONLY 1
#define O_RDWR 2
#define O_CREAT 0x200
#define O_TRUNC 0x400
#define O_APPEND 0x1000
#define O_NONBLOCK 0x800

typedef void (*sighandler_t)(int signal);
typedef int size_t;
typedef int ssize_t;
typedef int ptrdiff_t;

#include <stdarg.h>

struct sigaction {
  sighandler_t handler;
  int mask;
  int flags;
  int restorer;
};

struct timespec {
  int tv_sec;
  int tv_nsec;
};

struct timeval {
  int tv_sec;
  int tv_usec;
};

struct utsname {
  char sysname[32];
  char nodename[32];
  char release[32];
  char version[32];
  char machine[32];
  char domainname[32];
};

struct dirent {
  int ino;
  int offset;
  int reclen;
  int type;
  char name[16];
};

struct termios {
  int iflag;
  int oflag;
  int cflag;
  int lflag;
  int line;
  int cc[12];
};

struct winsize {
  int rows;
  int cols;
  int xpixel;
  int ypixel;
};

struct stat {
  int dev;
  int ino;
  int mode;
  int nlink;
  int uid;
  int gid;
  int rdev;
  int size;
  int blksize;
  int blocks;
  int atime;
  int mtime;
  int ctime;
};

struct pollfd {
  int fd;
  int events;
  int revents;
};

struct sockaddr_in {
  int sin_family;
  int sin_port;
  int sin_addr;
};

struct file_stream {
  int fd;
  int flags;
  int error;
  int eof;
  char **mem_buffer;
  size_t *mem_size;
  char *mem_data;
  int mem_capacity;
  int mem_length;
  int mem_position;
};
typedef struct file_stream FILE;

struct directory_stream {
  int fd;
  int next;
  int count;
  struct dirent entries[4];
};
typedef struct directory_stream DIR;

extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;

void *memcpy(void *destination, void *source, int length);
void *memmove(void *destination, void *source, int length);
void *memset(void *destination, int value, int length);
int memcmp(void *left, void *right, int length);
int strlen(char *text);
int strcmp(char *left, char *right);
int strncmp(char *left, char *right, int length);
char *strcpy(char *destination, char *source);
char *strncpy(char *destination, char *source, int length);
char *strcat(char *destination, char *source);
char *strchr(char *text, int character);
char *strrchr(char *text, int character);
char *strstr(char *text, char *needle);
char *strdup(char *text);
int atoi(char *text);
int strtol(char *text, char **endptr, int base);
unsigned int strtoul(char *text, char **endptr, int base);
int isspace(int character);
int isdigit(int character);
int isxdigit(int character);
int isalpha(int character);
int isalnum(int character);
int isupper(int character);
int islower(int character);
int toupper(int character);
int tolower(int character);

int write(int fd, char *buffer, int length);
int read(int fd, char *buffer, int length);
int open(char *path, int flags);
int close(int fd);
int fork(void);
int wait(void);
int waitpid(int pid, int *status, int options);
int exec(char *path, char **argv);
int execve(char *path, char **argv, char **envp);
int getpid(void);
int getppid(void);
int kill(int pid, int signal);
int signal(int signal, sighandler_t handler);
int sigaction(int signal, struct sigaction *action, struct sigaction *old_action);
int sigprocmask(int how, int mask, int *old_mask);
int setpgid(int pid, int pgid);
int setsid(void);
int tcsetpgrp(int pgid);
int tcgetpgrp(void);
int pipe(int *fds);
int dup(int fd);
int fcntl(int fd, int command, int argument);
int ioctl(int fd, int request, int argument);
int tcgetattr(int fd, struct termios *attributes);
int tcsetattr(int fd, int actions, struct termios *attributes);
int tcgetwinsize(int fd, struct winsize *size);
int tcsetwinsize(int fd, struct winsize *size);
int isatty(int fd);
int nanosleep(struct timespec *request, struct timespec *remaining);
int sleep(int seconds);
int brk(void *address);
void *sbrk(int increment);
void *mmap(void *address, int length, int protection, int flags, int fd, int offset);
int munmap(void *address, int length);
int mprotect(void *address, int length, int protection);
void *malloc(int size);
void free(void *pointer);
void *calloc(int count, int size);
void *realloc(void *pointer, int size);
int gettimeofday(struct timeval *value, void *timezone);
int clock_gettime(int clock_id, struct timespec *value);
int uname(struct utsname *name);
int getdents(int fd, struct dirent *entries, int count);
int stat(char *path, struct stat *value);
int fstat(int fd, struct stat *value);
int lstat(char *path, struct stat *value);
int chmod(char *path, int mode);
int chown(char *path, int uid, int gid);
int mkdir(char *path, int mode);
int rmdir(char *path);
int unlink(char *path);
int link(char *oldpath, char *newpath);
int rename(char *oldpath, char *newpath);
int symlink(char *target, char *linkpath);
int readlink(char *path, char *buffer, int size);
int lseek(int fd, int offset, int whence);
int getuid(void);
int getgid(void);
int poll(struct pollfd *fds, int count, int timeout);
int socket(int domain, int type, int protocol);
int bind(int fd, struct sockaddr_in *address, int length);
int listen(int fd, int backlog);
int accept(int fd, struct sockaddr_in *address, int *length);
int connect(int fd, struct sockaddr_in *address, int length);
int send(int fd, void *buffer, int length, int flags);
int recv(int fd, void *buffer, int length, int flags);
int sendto(int fd, void *buffer, int length, int flags,
  struct sockaddr_in *address, int address_length);
int recvfrom(int fd, void *buffer, int length, int flags,
  struct sockaddr_in *address, int *address_length);
int setsockopt(int fd, int level, int option, void *value, int length);
int htons(int value);
int ntohs(int value);
int htonl(int value);
int ntohl(int value);
void exit(int code);
int time(void);
void shutdown(void);

FILE *fdopen(int fd, char *mode);
FILE *fopen(char *path, char *mode);
FILE *open_memstream(char **buffer, size_t *size);
int fclose(FILE *stream);
int fflush(FILE *stream);
int fseek(FILE *stream, int offset, int whence);
int ftell(FILE *stream);
int feof(FILE *stream);
int ferror(FILE *stream);
void clearerr(FILE *stream);
int fileno(FILE *stream);
int fread(void *buffer, int size, int count, FILE *stream);
int fwrite(void *buffer, int size, int count, FILE *stream);
int fgetc(FILE *stream);
int fputc(int character, FILE *stream);
char *fgets(char *buffer, int size, FILE *stream);
int fputs(char *text, FILE *stream);
int puts(char *text);
int vfprintf(FILE *stream, char *format, va_list ap);
int vsnprintf(char *buffer, int size, char *format, va_list ap);
int snprintf(char *buffer, int size, char *format, ...);
int printf(char *format, ...);
int fprintf(FILE *stream, char *format, ...);
int print_int(int value);
FILE *tmpfile(void);
char *tmpnam(char *buffer);
int mkstemp(char *template);
int remove(char *path);

DIR *opendir(char *path);
struct dirent *readdir(DIR *directory);
void rewinddir(DIR *directory);
int closedir(DIR *directory);

char *getenv(char *name);
int setenv(char *name, char *value, int overwrite);
int unsetenv(char *name);
int putenv(char *entry);

char *basename(char *path);
char *dirname(char *path);
int path_join(char *output, int size, char *left, char *right);
