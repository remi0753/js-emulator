// echo: print the arguments separated by spaces, followed by a newline.

int main(int argc, char **argv) {
  int i;
  i = 1;
  while (i < argc) {
    write(1, argv[i], strlen(argv[i]));
    if (i + 1 < argc) {
      write(1, " ", 1);
    }
    i = i + 1;
  }
  write(1, "\n", 1);
  return 0;
}
