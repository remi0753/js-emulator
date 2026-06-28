#include "chibicc.h"

// See ccsupport.h. These are ordinary libc helpers, implemented over the
// existing guest libc (malloc/memcpy/strlen), kept local to the compiler build.

char *strndup(char *s, int n) {
  int len = 0;
  while (len < n && s[len]) len++;
  char *p = malloc(len + 1);
  memcpy(p, s, len);
  p[len] = 0;
  return p;
}

int ispunct(int c) {
  if (c >= '!' && c <= '/') return 1;
  if (c >= ':' && c <= '@') return 1;
  if (c >= '[' && c <= '`') return 1;
  if (c >= '{' && c <= '~') return 1;
  return 0;
}

static int lower(int c) {
  if (c >= 'A' && c <= 'Z') return c + 32;
  return c;
}

int strcasecmp(char *a, char *b) {
  for (;;) {
    int ca = lower((unsigned char)*a);
    int cb = lower((unsigned char)*b);
    if (ca != cb) return ca - cb;
    if (ca == 0) return 0;
    a++;
    b++;
  }
}

int strncasecmp(char *a, char *b, int n) {
  for (int i = 0; i < n; i++) {
    int ca = lower((unsigned char)a[i]);
    int cb = lower((unsigned char)b[i]);
    if (ca != cb) return ca - cb;
    if (ca == 0) return 0;
  }
  return 0;
}

char *strerror(int errnum) {
  (void)errnum;
  return "error";
}
