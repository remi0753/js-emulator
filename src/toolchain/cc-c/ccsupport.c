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

// Parse a decimal floating-point literal (the tokenizer's convert_pp_number
// path). custom32 has no hardware float, but this file is compiled by the
// bootstrap backend with soft-float, so plain `double` arithmetic works here.
// Not perfectly rounded, but accurate enough for ordinary C source literals.
// Hex floats and inf/nan spellings are not handled (the frontend never emits
// them for this target).
long double strtold(char *nptr, char **endptr) {
  char *p = nptr;
  while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
  int sign = 1;
  if (*p == '+') {
    p++;
  } else if (*p == '-') {
    sign = -1;
    p++;
  }
  double val = 0.0;
  while (*p >= '0' && *p <= '9') {
    val = val * 10.0 + (double)(*p - '0');
    p++;
  }
  if (*p == '.') {
    p++;
    double scale = 0.1;
    while (*p >= '0' && *p <= '9') {
      val = val + (double)(*p - '0') * scale;
      scale = scale * 0.1;
      p++;
    }
  }
  if (*p == 'e' || *p == 'E') {
    p++;
    int esign = 1;
    if (*p == '+') {
      p++;
    } else if (*p == '-') {
      esign = -1;
      p++;
    }
    int exp = 0;
    while (*p >= '0' && *p <= '9') {
      exp = exp * 10 + (*p - '0');
      p++;
    }
    double pw = 1.0;
    for (int i = 0; i < exp; i++) pw = pw * 10.0;
    if (esign < 0) val = val / pw;
    else val = val * pw;
  }
  if (endptr) *endptr = p;
  if (sign < 0) return -val;
  return val;
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
