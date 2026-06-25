// sh: libc-based shell with scripts, environment variables, redirection,
// process groups, background jobs, and pipelines of up to four commands.
#include "libc.h"

char line[128];
char *args[20];
char pathbuf[64];
char *script_argv[20];
char candidate[64];
char *redir_in;
char *redir_out;
int input_fd;
int pipefds[6];
int pids[4];
int starts[4];

void exec_path(char *path, char **av) {
  int i;
  exec(path, av);
  if (errno == 8) {
    script_argv[0] = "/bin/sh";
    script_argv[1] = path;
    i = 1;
    while (av[i] != 0 && i < 18) {
      script_argv[i + 1] = av[i];
      i = i + 1;
    }
    script_argv[i + 1] = 0;
    exec("/bin/sh", script_argv);
  }
}

// exec a command, searching /bin when the name contains no '/'. Returns only on
// failure (exec replaces the image on success).
void exec_cmd(char **av) {
  char *cmd;
  char *search;
  int i;
  int start;
  int out;
  cmd = av[0];
  i = 0;
  while (cmd[i] != 0) {
    if (cmd[i] == '/') {
      exec_path(cmd, av);
      return;
    }
    i = i + 1;
  }
  search = getenv("PATH");
  if (search == 0) search = "/bin";
  start = 0;
  while (1) {
    i = start;
    out = 0;
    while (search[i] != 0 && search[i] != ':') {
      if (out < 48) {
        pathbuf[out] = search[i];
        out = out + 1;
      }
      i = i + 1;
    }
    if (out == 0) {
      pathbuf[0] = '.';
      out = 1;
    }
    pathbuf[out] = 0;
    if (path_join(candidate, 64, pathbuf, cmd) == 0) {
      exec_path(candidate, av);
      if (errno != 2 && errno != 20) return;
    }
    if (search[i] == 0) return;
    start = i + 1;
  }
}

// Read one line into `line` (NUL-terminated, newline stripped). Returns the
// length, or -1 at end of input.
int readline() {
  int i;
  int n;
  char c;
  i = 0;
  n = read(input_fd, &c, 1);
  if (n <= 0) {
    line[0] = 0;
    return -1;
  }
  while (n > 0) {
    if (c == '\n') {
      break;
    }
    if (c == '\r') {
      n = read(input_fd, &c, 1);
      continue;
    }
    if (i < 127) {
      line[i] = c;
      i = i + 1;
    }
    n = read(input_fd, &c, 1);
  }
  line[i] = 0;
  return i;
}

// Split `line` in place into `args` (NUL-terminating each token). Returns argc.
int tokenize() {
  int i;
  int argc;
  int quote;
  i = 0;
  argc = 0;
  while (line[i] != 0) {
    while (line[i] == ' ' || line[i] == '\t') {
      i = i + 1;
    }
    if (line[i] == 0) {
      break;
    }
    quote = 0;
    if (line[i] == 39 || line[i] == 34) {
      quote = line[i];
      i = i + 1;
    }
    if (argc < 19) {
      args[argc] = line + i;
      argc = argc + 1;
    }
    if (quote != 0) {
      while (line[i] != 0 && line[i] != quote) i = i + 1;
    } else {
      while (line[i] != 0 && line[i] != ' ' && line[i] != '\t') i = i + 1;
    }
    if (line[i] != 0) {
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

int apply_redirections(int use_input, int use_output) {
  int fd;
  if (use_input != 0 && redir_in != 0) {
    fd = open(redir_in, 0);
    if (fd < 0) return -1;
    close(0);
    dup(fd);
    close(fd);
  }
  if (use_output != 0 && redir_out != 0) {
    fd = open(redir_out, 0x601);
    if (fd < 0) return -1;
    close(1);
    dup(fd);
    close(fd);
  }
  return 0;
}

int run_pipeline(int nargs, int background) {
  int commands;
  int command;
  int i;
  int group;
  int status;
  int created_pipes;
  int created_children;
  commands = 1;
  i = 0;
  while (i < nargs) {
    if (args[i][0] == '|' && args[i][1] == 0) {
      if (i == 0 || i + 1 == nargs ||
          (args[i - 1][0] == '|' && args[i - 1][1] == 0)) {
        write(2, "sh: bad pipeline\n", 17);
        return -1;
      }
      if (commands >= 4) {
        write(2, "sh: pipeline too long\n", 22);
        return -1;
      }
      commands = commands + 1;
    }
    i = i + 1;
  }
  starts[0] = 0;
  command = 1;
  i = 0;
  while (i < nargs) {
    if (args[i][0] == '|' && args[i][1] == 0) {
      args[i] = 0;
      starts[command] = i + 1;
      command = command + 1;
    }
    i = i + 1;
  }
  i = 0;
  created_pipes = 0;
  while (i + 1 < commands) {
    if (pipe(pipefds + i * 2) < 0) {
      while (created_pipes > 0) {
        created_pipes = created_pipes - 1;
        close(pipefds[created_pipes * 2]);
        close(pipefds[created_pipes * 2 + 1]);
      }
      return -1;
    }
    created_pipes = created_pipes + 1;
    i = i + 1;
  }
  group = 0;
  command = 0;
  created_children = 0;
  while (command < commands) {
    pids[command] = fork();
    if (pids[command] < 0) {
      i = 0;
      while (i < created_pipes * 2) {
        close(pipefds[i]);
        i = i + 1;
      }
      i = 0;
      while (i < created_children) {
        kill(pids[i], 9);
        i = i + 1;
      }
      i = 0;
      while (i < created_children) {
        waitpid(pids[i], &status, 0);
        i = i + 1;
      }
      return -1;
    }
    if (pids[command] == 0) {
      if (command == 0) setpgid(0, 0);
      else setpgid(0, group);
      signal(2, 0);
      if (command > 0) {
        close(0);
        dup(pipefds[(command - 1) * 2]);
      }
      if (command + 1 < commands) {
        close(1);
        dup(pipefds[command * 2 + 1]);
      }
      i = 0;
      while (i < (commands - 1) * 2) {
        close(pipefds[i]);
        i = i + 1;
      }
      if (apply_redirections(command == 0, command + 1 == commands) < 0) exit(1);
      exec_cmd(args + starts[command]);
      write(2, "sh: exec failed\n", 16);
      exit(1);
    }
    if (command == 0) group = pids[0];
    setpgid(pids[command], group);
    created_children = created_children + 1;
    command = command + 1;
  }
  i = 0;
  while (i < (commands - 1) * 2) {
    close(pipefds[i]);
    i = i + 1;
  }
  if (background == 0) {
    tcsetpgrp(group);
    command = 0;
    while (command < commands) {
      waitpid(pids[command], &status, 2);
      command = command + 1;
    }
    tcsetpgrp(getpid());
  }
  return 0;
}

int run_builtin(int nargs) {
  int i;
  char *equals;
  i = 0;
  while (i < nargs) {
    if (args[i][0] == '|' && args[i][1] == 0) return 0;
    i = i + 1;
  }
  if (strcmp(args[0], "exit") == 0) return 1;
  if (strcmp(args[0], "export") == 0) {
    if (nargs > 1) {
      equals = strchr(args[1], '=');
      if (equals != 0) {
        *equals = 0;
        setenv(args[1], equals + 1, 1);
      }
    }
    return 2;
  }
  if (strcmp(args[0], "unset") == 0) {
    if (nargs > 1) unsetenv(args[1]);
    return 2;
  }
  if (strcmp(args[0], "env") == 0) {
    i = 0;
    while (environ != 0 && environ[i] != 0) {
      puts(environ[i]);
      i = i + 1;
    }
    return 2;
  }
  return 0;
}

int main(int argc, char **argv) {
  int n;
  int nargs;
  int background;
  int status;
  int builtin;
  input_fd = 0;
  if (argc > 1) {
    input_fd = open(argv[1], 0);
    if (input_fd < 0) {
      write(2, "sh: cannot open script\n", 23);
      return 1;
    }
  }
  setsid();
  if (input_fd == 0) tcsetpgrp(getpid());
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
    if (line[0] == '#') continue;
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
    builtin = run_builtin(nargs);
    if (builtin == 1) break;
    if (builtin == 0) run_pipeline(nargs, background);
  }
  if (input_fd != 0) close(input_fd);
  return 0;
}
