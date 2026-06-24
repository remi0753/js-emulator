// sh: a small shell. Reads a line from stdin, splits it on spaces into argv,
// and runs it. Supports one pipeline stage and a trailing `&`. Foreground jobs
// receive the terminal foreground process group; background jobs are reaped
// without blocking the command loop.

char line[128];
char *args[20];
char pathbuf[64];
char *redir_in;
char *redir_out;

// exec a command, searching /bin when the name contains no '/'. Returns only on
// failure (exec replaces the image on success).
void exec_cmd(char **av) {
  char *cmd;
  int i;
  cmd = av[0];
  i = 0;
  while (cmd[i] != 0) {
    if (cmd[i] == '/') {
      exec(cmd, av);
      return;
    }
    i = i + 1;
  }
  pathbuf[0] = '/';
  pathbuf[1] = 'b';
  pathbuf[2] = 'i';
  pathbuf[3] = 'n';
  pathbuf[4] = '/';
  i = 0;
  while (cmd[i] != 0 && i < 58) {
    pathbuf[5 + i] = cmd[i];
    i = i + 1;
  }
  pathbuf[5 + i] = 0;
  exec(pathbuf, av);
}

// Read one line into `line` (NUL-terminated, newline stripped). Returns the
// length, or -1 at end of input.
int readline() {
  int i;
  int n;
  char c;
  i = 0;
  n = read(0, &c, 1);
  if (n <= 0) {
    line[0] = 0;
    return -1;
  }
  while (n > 0) {
    if (c == '\n') {
      break;
    }
    if (i < 127) {
      line[i] = c;
      i = i + 1;
    }
    n = read(0, &c, 1);
  }
  line[i] = 0;
  return i;
}

// Split `line` in place into `args` (NUL-terminating each token). Returns argc.
int tokenize() {
  int i;
  int argc;
  i = 0;
  argc = 0;
  while (line[i] != 0) {
    while (line[i] == ' ') {
      i = i + 1;
    }
    if (line[i] == 0) {
      break;
    }
    if (argc < 19) {
      args[argc] = line + i;
      argc = argc + 1;
    }
    while (line[i] != 0 && line[i] != ' ') {
      i = i + 1;
    }
    if (line[i] == ' ') {
      line[i] = 0;
      i = i + 1;
    }
  }
  args[argc] = 0;
  return argc;
}

int parse_redirections(int argc) {
  int i;
  int out;
  redir_in = 0;
  redir_out = 0;
  i = 0;
  out = 0;
  while (i < argc) {
    if ((args[i][0] == '<' || args[i][0] == '>') &&
        args[i][1] == 0) {
      if (i + 1 >= argc) return -1;
      if (args[i][0] == '<') redir_in = args[i + 1];
      else redir_out = args[i + 1];
      i = i + 2;
    } else {
      args[out] = args[i];
      out = out + 1;
      i = i + 1;
    }
  }
  args[out] = 0;
  return out;
}

int apply_redirections() {
  int fd;
  if (redir_in != 0) {
    fd = open(redir_in, 0);
    if (fd < 0) return -1;
    close(0);
    dup(fd);
    close(fd);
  }
  if (redir_out != 0) {
    fd = open(redir_out, 0x601);
    if (fd < 0) return -1;
    close(1);
    dup(fd);
    close(fd);
  }
  return 0;
}

void run_single(char **av, int background) {
  int pid;
  int status;
  pid = fork();
  if (pid == 0) {
    setpgid(0, 0);
    signal(2, 0);
    if (apply_redirections() < 0) exit(1);
    exec_cmd(av);
    write(2, "sh: exec failed\n", 16);
    exit(1);
  }
  setpgid(pid, pid);
  if (background == 0) {
    tcsetpgrp(pid);
    waitpid(pid, &status, 2);
    tcsetpgrp(getpid());
  }
}

// cmd1 | cmd2: wire cmd1's stdout to cmd2's stdin through a pipe. The
// close(fd)/dup() dance relies on dup() returning the lowest free descriptor.
void run_pipe(char **av1, char **av2, int background) {
  int fds[2];
  int pid1;
  int pid2;
  int status;
  pipe(fds);
  pid1 = fork();
  if (pid1 == 0) {
    setpgid(0, 0);
    signal(2, 0);
    close(1);
    dup(fds[1]); // -> fd 1 (stdout to pipe write end)
    close(fds[0]);
    close(fds[1]);
    exec_cmd(av1);
    exit(1);
  }
  setpgid(pid1, pid1);
  pid2 = fork();
  if (pid2 == 0) {
    setpgid(0, pid1);
    signal(2, 0);
    close(0);
    dup(fds[0]); // -> fd 0 (stdin from pipe read end)
    close(fds[0]);
    close(fds[1]);
    exec_cmd(av2);
    exit(1);
  }
  setpgid(pid2, pid1);
  close(fds[0]);
  close(fds[1]);
  if (background == 0) {
    tcsetpgrp(pid1);
    waitpid(pid1, &status, 2);
    waitpid(pid2, &status, 2);
    tcsetpgrp(getpid());
  }
}

int main(int argc, char **argv) {
  int n;
  int i;
  int nargs;
  int pipe_at;
  int background;
  int status;
  setsid();
  tcsetpgrp(getpid());
  signal(2, 1); // the shell itself survives Ctrl-C; children reset SIGINT
  while (1) {
    while (waitpid(-1, &status, 1) > 0) {
    }
    n = readline();
    if (n < 0) {
      break;
    }
    if (n == 0) {
      continue;
    }
    nargs = tokenize();
    nargs = parse_redirections(nargs);
    if (nargs < 0) {
      write(2, "sh: bad redirection\n", 20);
      continue;
    }
    if (nargs == 0) {
      continue;
    }
    background = 0;
    if (args[nargs - 1][0] == 38 && args[nargs - 1][1] == 0) {
      background = 1;
      nargs = nargs - 1;
      args[nargs] = 0;
      if (nargs == 0) {
        continue;
      }
    }
    pipe_at = -1;
    i = 0;
    while (i < nargs) {
      if (args[i][0] == '|' && args[i][1] == 0) {
        pipe_at = i;
      }
      i = i + 1;
    }
    if (pipe_at < 0) {
      run_single(args, background);
    } else {
      args[pipe_at] = 0;
      run_pipe(args, args + pipe_at + 1, background);
    }
  }
  return 0;
}
