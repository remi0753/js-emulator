// init: the first user program. Spawn the shell and wait for it. When the shell
// exits (end of input), init exits too; the kernel halts once nothing is
// runnable. Linked against libc (write/read/fork/exec/wait/exit live there).
#include "libc.h"

char *shargv[2];
char *rcargv[3];

int main(int argc, char **argv) {
  int pid;
  int status;
  rcargv[0] = "/bin/sh";
  rcargv[1] = "/etc/rc";
  rcargv[2] = 0;
  pid = fork();
  if (pid == 0) {
    exec("/bin/sh", rcargv);
    exit(1);
  }
  waitpid(pid, &status, 0);
  shargv[0] = "/bin/sh";
  shargv[1] = 0;
  pid = fork();
  if (pid == 0) {
    exec("/bin/sh", shargv);
    write(2, "init: exec /bin/sh failed\n", 26);
    exit(1);
  }
  wait();
  exit(0);
  return 0;
}
