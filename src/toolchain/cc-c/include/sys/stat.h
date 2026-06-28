#ifndef JSCPU_CC_SYS_STAT_H
#define JSCPU_CC_SYS_STAT_H
#include "libc.h"

// The guest libc `struct stat` uses bare field names (mtime, size, ...). Map the
// POSIX `st_`-prefixed names the vendored chibicc source expects onto them.
#define st_mtime mtime
#define st_atime atime
#define st_ctime ctime
#define st_size size
#define st_mode mode
#endif
