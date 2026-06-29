#include "upstream/chibicc.h"
#include "guestlink.h"

StringArray include_paths;
bool opt_fpic;
bool opt_fcommon = true;
char *base_file;

static char *inputs[128];
static int input_count;
static char *output_path;
static bool opt_asm;

bool file_exists(char *path) {
  struct stat st;
  return stat(path, &st) == 0;
}

static void usage(int status) {
  FILE *out = status == 0 ? stdout : stderr;
  fprintf(out, "usage: cc [-S] [-I dir] [-o output] input.c\n");
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
      opt_asm = true;
      i = i + 1;
      continue;
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
    // `@file` response file: read whitespace-separated input paths from `file`.
    // The kernel caps argv tightly, so a large link is driven from a list file.
    if (argv[i][0] == '@') {
      char *list = guest_read_file(argv[i] + 1);
      int p = 0;
      while (list[p] != 0) {
        while (list[p] == ' ' || list[p] == '\t' || list[p] == '\n' || list[p] == '\r') p++;
        if (list[p] == 0) break;
        int start = p;
        while (list[p] != 0 && list[p] != ' ' && list[p] != '\t' && list[p] != '\n' &&
               list[p] != '\r')
          p++;
        char *token = calloc(p - start + 1, 1);
        memcpy(token, list + start, p - start);
        if (input_count >= 128) {
          fprintf(stderr, "cc: too many input files\n");
          exit(1);
        }
        inputs[input_count] = token;
        input_count = input_count + 1;
      }
      i = i + 1;
      continue;
    }
    if (input_count >= 128) {
      fprintf(stderr, "cc: too many input files\n");
      exit(1);
    }
    inputs[input_count] = argv[i];
    input_count = input_count + 1;
    i = i + 1;
  }
  if (input_count == 0) usage(1);
  if (output_path == 0) {
    if (opt_asm) output_path = replace_ext(inputs[0], ".s");
    else output_path = "a.out";
  }
}

static bool ends_with(char *s, char *suffix) {
  int ls = strlen(s);
  int lt = strlen(suffix);
  if (lt > ls) return false;
  return strcmp(s + ls - lt, suffix) == 0;
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

static char *compile_to_asm_memory(char *input) {
  Token *tok;
  Obj *prog;
  FILE *out;
  char *buffer;
  size_t size;
  base_file = input;
  tok = tokenize_file(input);
  if (tok == 0) {
    fprintf(stderr, "cc: cannot open %s: %s\n", input, strerror(errno));
    exit(1);
  }
  init_macros();
  tok = preprocess(tok);
  prog = parse(tok);

  buffer = 0;
  size = 0;
  out = open_memstream(&buffer, &size);
  if (out == 0) {
    fprintf(stderr, "cc: cannot create assembly buffer\n");
    exit(1);
  }
  codegen(prog, out);
  fclose(out);
  return buffer;
}

int main(int argc, char **argv) {
  char *assembly;
  add_default_include_paths();
  parse_args(argc, argv);

  if (opt_asm) {
    if (input_count != 1) {
      fprintf(stderr, "cc: -S accepts exactly one input file\n");
      exit(1);
    }
    compile_to_asm(inputs[0], output_path);
    return 0;
  }

  // Link mode: when every input is assembly, assemble each translation unit and
  // link them (plus crt/libc/runtime assembly) into one guest executable.
  bool all_asm = true;
  for (int i = 0; i < input_count; i++)
    if (!ends_with(inputs[i], ".s")) all_asm = false;
  if (all_asm) {
    link_guest_objects(inputs, input_count, output_path);
    return 0;
  }

  // Single-source convenience path: compile, assemble, and link one .c file
  // with the built-in crt in one step.
  if (input_count != 1) {
    fprintf(stderr, "cc: mixed or multiple non-assembly inputs are not supported; compile each with -S, then link the .s files\n");
    exit(1);
  }
  assembly = compile_to_asm_memory(inputs[0]);
  assemble_and_link_guest(assembly, output_path);
  return 0;
}
