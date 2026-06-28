#ifndef JSCPU_CC_TIME_H
#define JSCPU_CC_TIME_H

// Minimal <time.h> for the vendored chibicc source. Only the broken-down time
// shape and the calls used by the __DATE__/__TIME__/__TIMESTAMP__ builtins are
// needed; the guest libc supplies `time` itself.
typedef long time_t;

struct tm {
  int tm_sec;
  int tm_min;
  int tm_hour;
  int tm_mday;
  int tm_mon;
  int tm_year;
  int tm_wday;
  int tm_yday;
  int tm_isdst;
};

struct tm *localtime(time_t *timep);
char *ctime_r(time_t *timep, char *buf);

#endif
