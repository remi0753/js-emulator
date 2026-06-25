// PIO NIC driver. The device raises IRQ2 whenever a frame is queued.
#include "kernel.h"

char net_rx_frame[1518];

void network_drain(void) {
  int length;
  int i;
  while ((__in(CFG_NET_STATUS) & 1) != 0) {
    length = __in(CFG_NET_RX_LEN);
    if (length <= 0 || length > 1518) return;
    i = 0;
    while (i < length) {
      net_rx_frame[i] = __in(CFG_NET_RX_DATA);
      i = i + 1;
    }
    net_receive_frame(net_rx_frame, length);
  }
}

void on_network_irq(void) {
  network_drain();
}
