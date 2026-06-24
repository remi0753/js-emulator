// Real-time clock driver: read the wall-clock time (Unix seconds) from the RTC
// device port.
#include "kernel.h"

int rtc_time(void) {
  return __in(CFG_RTC_DATA);
}
