#include "libc.h"

char grep_line[128];

int main(int argc, char **argv) {
  FILE *stream;
  if (argc < 2) {
    write(2, "usage: grep pattern [file]\n", 27);
    return 2;
  }
  stream = stdin;
  if (argc > 2) {
    stream = fopen(argv[2], "r");
    if (stream == 0) return 1;
  }
  while (fgets(grep_line, 128, stream) != 0) {
    if (strstr(grep_line, argv[1]) != 0) fputs(grep_line, stdout);
  }
  if (stream != stdin) fclose(stream);
  return 0;
}
