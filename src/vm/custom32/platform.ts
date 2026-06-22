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
} as const;
