#include "upstream/chibicc.h"
#include "guestlink.h"

// Standalone guest linker: combine relocatable `.o` objects (and/or `.s`
// assembly sources) into one guest executable. The inputs must collectively
// define `_start`; pass the crt object first, exactly as a real `ld` invocation
// would. The layout/relocation work lives in guestlink.c's link_guest_objects;
// this is the command-line front end, mirroring `cc` link mode.
//
// Like `cc`, `ld` accepts an `@listfile` response file whose whitespace-
// separated entries are extra inputs, so a large link survives the kernel's
// tight argv cap.

static char *inputs[256];
static int input_count;

static void push_input(char *path) {
  if (input_count >= 256) {
    fprintf(stderr, "ld: too many input files\n");
    exit(1);
  }
  inputs[input_count] = path;
  input_count = input_count + 1;
}

static void expand_listfile(char *path) {
  char *list = guest_read_file(path);
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
    push_input(token);
  }
}

int main(int argc, char **argv) {
  char *output_path = "a.out";

  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "-o")) {
      if (i + 1 >= argc) {
        fprintf(stderr, "ld: -o requires an argument\n");
        return 1;
      }
      output_path = argv[i + 1];
      i = i + 1;
      continue;
    }
    if (argv[i][0] == '@') {
      expand_listfile(argv[i] + 1);
      continue;
    }
    if (argv[i][0] == '-') {
      fprintf(stderr, "ld: unsupported option: %s\n", argv[i]);
      return 1;
    }
    push_input(argv[i]);
  }

  if (input_count == 0) {
    fprintf(stderr, "usage: ld [-o output] input.o ...\n");
    return 1;
  }
  link_guest_objects(inputs, input_count, output_path);
  return 0;
}
