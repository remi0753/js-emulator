#include "upstream/chibicc.h"

StringArray include_paths;
bool opt_fpic;
bool opt_fcommon = true;
char *base_file;

static char *input_path;
static char *output_path;

bool file_exists(char *path) {
  struct stat st;
  return stat(path, &st) == 0;
}

static void usage(int status) {
  FILE *out = status == 0 ? stdout : stderr;
  fprintf(out, "usage: cc [-S] [-I dir] [-o output.s] input.c\n");
  exit(status);
}

static bool startswith2(char *s, char *prefix) {
  return strncmp(s, prefix, strlen(prefix)) == 0;
}

static char *replace_ext(char *path, char *ext) {
  char *out;
  int len;
  int dot;
  len = strlen(path);
  dot = len;
  while (dot > 0 && path[dot - 1] != '/' && path[dot - 1] != '.') dot--;
  if (dot == 0 || path[dot - 1] != '.') dot = len;
  out = calloc(dot + strlen(ext) + 1, 1);
  memcpy(out, path, dot);
  strcpy(out + dot, ext);
  return out;
}

static void parse_args(int argc, char **argv) {
  int i;
  i = 1;
  while (i < argc) {
    if (!strcmp(argv[i], "--help")) usage(0);
    if (!strcmp(argv[i], "-S")) {
      i = i + 1;
      continue;
    }
    if (!strcmp(argv[i], "-c")) {
      fprintf(stderr, "cc: -c waits on guest as/ld; use -S for now\n");
      exit(1);
    }
    if (!strcmp(argv[i], "-o")) {
      if (i + 1 >= argc) usage(1);
      output_path = argv[i + 1];
      i = i + 2;
      continue;
    }
    if (!strcmp(argv[i], "-I")) {
      if (i + 1 >= argc) usage(1);
      strarray_push(&include_paths, argv[i + 1]);
      i = i + 2;
      continue;
    }
    if (startswith2(argv[i], "-I") && argv[i][2] != 0) {
      strarray_push(&include_paths, argv[i] + 2);
      i = i + 1;
      continue;
    }
    if (argv[i][0] == '-') {
      fprintf(stderr, "cc: unsupported option: %s\n", argv[i]);
      exit(1);
    }
    if (input_path != 0) {
      fprintf(stderr, "cc: multiple input files are not supported yet\n");
      exit(1);
    }
    input_path = argv[i];
    i = i + 1;
  }
  if (input_path == 0) usage(1);
  if (output_path == 0) output_path = replace_ext(input_path, ".s");
}

static void add_default_include_paths(void) {
  strarray_push(&include_paths, ".");
  strarray_push(&include_paths, "/include");
  strarray_push(&include_paths, "/usr/include");
}

static void compile_to_asm(char *input, char *output) {
  Token *tok;
  Obj *prog;
  FILE *out;
  base_file = input;
  tok = tokenize_file(input);
  if (tok == 0) {
    fprintf(stderr, "cc: cannot open %s: %s\n", input, strerror(errno));
    exit(1);
  }
  init_macros();
  tok = preprocess(tok);
  prog = parse(tok);

  out = fopen(output, "w");
  if (out == 0) {
    fprintf(stderr, "cc: cannot open %s: %s\n", output, strerror(errno));
    exit(1);
  }
  codegen(prog, out);
  fclose(out);
}

int main(int argc, char **argv) {
  add_default_include_paths();
  parse_args(argc, argv);
  compile_to_asm(input_path, output_path);
  return 0;
}
