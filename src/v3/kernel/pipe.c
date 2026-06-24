// Pipes. Each pipe object owns its ring buffer and endpoint reference counts.
#include "kernel.h"

struct pipe pipe_table[CFG_NPIPE];

int alloc_pipe(void) {
  int i;
  i = 0;
  while (i < CFG_NPIPE) {
    if (pipe_table[i].used == 0) {
      pipe_table[i].used = 1;
      pipe_table[i].count = 0;
      pipe_table[i].head = 0;
      pipe_table[i].nread = 1;
      pipe_table[i].nwrite = 1;
      return i;
    }
    i = i + 1;
  }
  return -1;
}

int pipe_write_bytes(int pp, int buf, int len) {
  struct pipe *pipe;
  int space;
  int n;
  int k;
  int idx;
  pipe = &pipe_table[pp];
  space = CFG_PIPESZ - pipe->count;
  n = len;
  if (n > space) {
    n = space;
  }
  k = 0;
  while (k < n) {
    idx = (pipe->head + pipe->count) % CFG_PIPESZ;
    pipe->data[idx] = read8_at(buf + k);
    pipe->count = pipe->count + 1;
    k = k + 1;
  }
  return n;
}

int pipe_read_bytes(int pp, int buf, int len) {
  struct pipe *pipe;
  int n;
  int k;
  pipe = &pipe_table[pp];
  n = len;
  if (n > pipe->count) {
    n = pipe->count;
  }
  k = 0;
  while (k < n) {
    write8_at(buf + k, pipe->data[pipe->head]);
    pipe->head = (pipe->head + 1) % CFG_PIPESZ;
    pipe->count = pipe->count - 1;
    k = k + 1;
  }
  return n;
}
