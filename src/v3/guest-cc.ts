// Guest-target conveniences for the custom32-cc driver.
//
// `src/toolchain/cc.ts` is OS-generation independent: it compiles, lowers, and
// links objects but does not know the guest's load address, executable magic, or
// disk layout. This module supplies those guest specifics — it is the same
// boundary `guest-kernel.ts` occupies for the source-level linker.

import type { Archive } from '../formats/archive.ts';
import type { ObjectFile } from '../formats/object.ts';
import { Fs } from '../storage/fs.ts';
import { PortBlockDevice } from '../storage/port-block-device.ts';
import { linkExecutableImage } from '../toolchain/cc.ts';
import { BlockDisk } from '../vm/custom32/devices/disk.ts';
import { PORT } from '../vm/custom32/platform.ts';
import { PortBus } from '../vm/custom32/ports.ts';
import { GUEST_EXECUTABLE_MAGIC, GUEST_KERNEL_LAYOUT } from './config.ts';

export interface GuestLinkOptions {
  entry?: string;
  textOrigin?: number;
}

// Link objects + archives into a guest-loadable executable at the guest user
// load base with the guest executable magic.
export function linkGuestExecutable(
  objects: ObjectFile[],
  archives: Archive[] = [],
  options: GuestLinkOptions = {},
): Uint8Array {
  return linkExecutableImage(objects, archives, {
    format: 'guest',
    magic: GUEST_EXECUTABLE_MAGIC,
    textOrigin: options.textOrigin ?? GUEST_KERNEL_LAYOUT.userLoadBase,
    entry: options.entry ?? '_start',
  });
}

// Install an executable into a disk image's filesystem at `path` (mode 0755),
// mutating and returning the image bytes. Used by `custom32-cc --install`.
export function installExecutable(image: Uint8Array, path: string, bytes: Uint8Array): Uint8Array {
  const ports = new PortBus();
  const disk = new BlockDisk(image);
  ports.register(PORT.DISK_DATA, 1, disk);
  ports.register(PORT.DISK_POS, 1, disk);
  ports.register(PORT.DISK_SECTORS, 1, disk);
  const fs = new Fs(new PortBlockDevice(ports));
  fs.mount();
  fs.writeFile(path, bytes);
  fs.chmod(path, 0o755);
  return disk.data;
}
