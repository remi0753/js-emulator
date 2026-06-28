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

long double strtold(char *nptr, char **endptr) {
  return strtol(nptr, endptr, 0);
}

static struct tm deterministic_tm;

struct tm *localtime(time_t *timep) {
  (void)timep;
  deterministic_tm.tm_sec = 0;
  deterministic_tm.tm_min = 0;
  deterministic_tm.tm_hour = 0;
  deterministic_tm.tm_mday = 1;
  deterministic_tm.tm_mon = 0;
  deterministic_tm.tm_year = 126;
  deterministic_tm.tm_wday = 4;
  deterministic_tm.tm_yday = 0;
  deterministic_tm.tm_isdst = 0;
  return &deterministic_tm;
}

char *ctime_r(time_t *timep, char *buf) {
  (void)timep;
  strcpy(buf, "Thu Jan  1 00:00:00 2026\n");
  return buf;
}
