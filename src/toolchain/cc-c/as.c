#include "upstream/chibicc.h"
#include "guestlink.h"

// Standalone guest assembler: turn custom32 `.s` assembly into a relocatable
// `.o` object the linker (cc link mode or `ld`) can later combine. The actual
// assembling and object serialization live in guestlink.c; this is just the
// command-line front end, mirroring `cc -c` for a single `.s` input.

static char *replace_ext(char *path, char *ext) {
  int len = strlen(path);
  int cut = len;
  while (cut > 0 && path[cut - 1] != '/' && path[cut - 1] != '.') cut--;
  if (cut == 0 || path[cut - 1] != '.') cut = len;  // no extension: just append
  else cut = cut - 1;  // drop the existing `.` so `ext` (which carries one) wins
  char *out = calloc(cut + strlen(ext) + 1, 1);
  memcpy(out, path, cut);
  strcpy(out + cut, ext);
  return out;
}

int main(int argc, char **argv) {
  char *inputs[128];
  int input_count = 0;
  char *output_path = 0;

  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "-o")) {
      if (i + 1 >= argc) {
        fprintf(stderr, "as: -o requires an argument\n");
        return 1;
      }
      output_path = argv[i + 1];
      i = i + 1;
      continue;
    }
    if (argv[i][0] == '-') {
      fprintf(stderr, "as: unsupported option: %s\n", argv[i]);
      return 1;
    }
    if (input_count >= 128) {
      fprintf(stderr, "as: too many input files\n");
      return 1;
    }
    inputs[input_count] = argv[i];
    input_count = input_count + 1;
  }

  if (input_count == 0) {
    fprintf(stderr, "usage: as [-o output.o] input.s\n");
    return 1;
  }
  if (output_path != 0 && input_count != 1) {
    fprintf(stderr, "as: cannot specify -o with multiple input files\n");
    return 1;
  }

  for (int i = 0; i < input_count; i++) {
    char *out = output_path ? output_path : replace_ext(inputs[i], ".o");
    assemble_to_object(guest_read_file(inputs[i]), out);
  }
  return 0;
}
