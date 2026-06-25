// Public C library interface for custom32 user programs. The guest compiler's
// include pass deduplicates this file, so traditional preprocessor guards are
// unnecessary.

extern int errno;
extern char **environ;

typedef void (*sighandler_t)(int signal);

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

struct file_stream {
  int fd;
  int flags;
  int error;
  int eof;
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
void exit(int code);
int time(void);
void shutdown(void);

FILE *fdopen(int fd, char *mode);
FILE *fopen(char *path, char *mode);
int fclose(FILE *stream);
int fflush(FILE *stream);
int fread(void *buffer, int size, int count, FILE *stream);
int fwrite(void *buffer, int size, int count, FILE *stream);
int fgetc(FILE *stream);
int fputc(int character, FILE *stream);
char *fgets(char *buffer, int size, FILE *stream);
int fputs(char *text, FILE *stream);
int puts(char *text);
int printf(char *text);
int fprintf(FILE *stream, char *text);
int print_int(int value);

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
