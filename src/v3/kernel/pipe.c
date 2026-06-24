// Pipes. Each is a ring buffer with reader/writer reference counts; when both
// hit zero the pipe is freed, and a write-end count of zero is EOF for readers.
#include "kernel.h"

int pipe_used[CFG_NPIPE];
int pipe_count[CFG_NPIPE]; // bytes currently buffered
int pipe_head[CFG_NPIPE];  // read position
int pipe_nread[CFG_NPIPE]; // open read ends
int pipe_nwrite[CFG_NPIPE]; // open write ends
char pipe_buf[CFG_PIPE_BUF_LEN]; // NPIPE * PIPESZ

int alloc_pipe(void) {
  int i;
  i = 0;
  while (i < CFG_NPIPE) {
    if (pipe_used[i] == 0) {
      pipe_used[i] = 1;
      pipe_count[i] = 0;
      pipe_head[i] = 0;
      pipe_nread[i] = 1;
      pipe_nwrite[i] = 1;
      return i;
    }
    i = i + 1;
  }
  return -1;
}

int pipe_write_bytes(int pp, int buf, int len) {
  int space;
  int n;
  int k;
  int idx;
  space = CFG_PIPESZ - pipe_count[pp];
  n = len;
  if (n > space) {
    n = space;
  }
  k = 0;
  while (k < n) {
    idx = (pipe_head[pp] + pipe_count[pp]) % CFG_PIPESZ;
    pipe_buf[pp * CFG_PIPESZ + idx] = read8_at(buf + k);
    pipe_count[pp] = pipe_count[pp] + 1;
    k = k + 1;
  }
  return n;
}

int pipe_read_bytes(int pp, int buf, int len) {
  int n;
  int k;
  n = len;
  if (n > pipe_count[pp]) {
    n = pipe_count[pp];
  }
  k = 0;
  while (k < n) {
    write8_at(buf + k, pipe_buf[pp * CFG_PIPESZ + pipe_head[pp]]);
    pipe_head[pp] = (pipe_head[pp] + 1) % CFG_PIPESZ;
    pipe_count[pp] = pipe_count[pp] - 1;
    k = k + 1;
  }
  return n;
}
