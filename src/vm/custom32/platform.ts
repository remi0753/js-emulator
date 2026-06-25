// Platform constants for the custom32 virtual machine.
//
// These are hardware-facing assignments. Kernel ABIs may re-export them for
// compatibility, but the VM must not import kernel code to discover its ports.

export const PORT = {
  CONSOLE_DATA: 0x3f8, // write a byte here to emit one character (COM1-ish)
  DISK_DATA: 0x1f0, // read/write one 32-bit word at the disk position; auto-advances
  DISK_POS: 0x1f2, // set the disk access position (in sectors)
  DISK_SECTORS: 0x1f7, // read: number of sectors on the disk
  KBD_DATA: 0x60, // read: next input byte from the keyboard (0 if empty)
  KBD_STATUS: 0x64, // read: bit 0 = data available, bit 1 = input closed/EOF
  RTC_DATA: 0x70, // read: current wall-clock time as a Unix timestamp (seconds)
  NET_STATUS: 0x300, // read: bit 0 = an Ethernet frame is queued
  NET_RX_LEN: 0x301, // read: length of the next received frame
  NET_RX_DATA: 0x302, // read: next byte of the current received frame
  NET_TX_LEN: 0x303, // write: length of the frame about to be transmitted
  NET_TX_DATA: 0x304, // write: one byte; frame commits after NET_TX_LEN bytes
  POWER: 0x604, // write: power control; POWER_OFF shuts the machine down (ACPI-ish)
} as const;
