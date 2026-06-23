// shutdown: power the machine off through the power device. shutdown() asks the
// kernel, which writes the power-off command to the power controller port; the
// machine stops cleanly, so this never returns.

int main(int argc, char **argv) {
  shutdown();
  return 0;
}
