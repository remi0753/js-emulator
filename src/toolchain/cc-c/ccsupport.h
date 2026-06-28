#ifndef JSCPU_CC_SUPPORT_H
#define JSCPU_CC_SUPPORT_H

// Small libc functions the vendored chibicc frontend needs that the guest libc
// does not yet provide. Kept local to the compiler build so the shared guest
// libc is untouched during the Phase 34 bootstrap.

char *strndup(char *s, int n);
int ispunct(int c);
int strcasecmp(char *a, char *b);
int strncasecmp(char *a, char *b, int n);
char *strerror(int errnum);
long double strtold(char *nptr, char **endptr);
struct tm *localtime(time_t *timep);
char *ctime_r(time_t *timep, char *buf);

#endif
