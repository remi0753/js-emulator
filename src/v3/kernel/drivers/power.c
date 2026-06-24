// Power controller driver: write the power-off command to the power device, and
// the machine stops cleanly at the next instruction boundary.
#include "kernel.h"

void power_off(void) {
  __out(CFG_POWER, CFG_POWER_OFF);
}
