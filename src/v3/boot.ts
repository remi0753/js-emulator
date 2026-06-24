import {
  BOOT_MAGIC,
  BOOT_SIGNATURE,
  BOOT_VERSION,
  type BootBlock,
  decodeBootBlock,
} from '../formats/bootblock.ts';
import { BLOCK_SIZE } from '../storage/block.ts';
import { Machine, type MachineOptions } from '../vm/custom32/machine.ts';
import { GUEST_KERNEL_LAYOUT } from './config.ts';

export interface BootedGuest {
  machine: Machine;
  manifest: BootBlock;
}

export type GuestBootOptions = Omit<MachineOptions, 'diskImage' | 'physSize'> & {
  physSize?: number;
};

export function readGuestBootBlock(diskImage: Uint8Array): BootBlock {
  if (diskImage.length < BLOCK_SIZE || diskImage.length % BLOCK_SIZE !== 0) {
    throw new Error('boot: disk image must contain whole 512-byte sectors');
  }
  const manifest = decodeBootBlock(diskImage.subarray(0, BLOCK_SIZE));
  if (manifest.magic !== BOOT_MAGIC) throw new Error('boot: disk is not bootable');
  if (manifest.signature !== BOOT_SIGNATURE) {
    throw new Error('boot: invalid boot-sector signature');
  }
  if (manifest.version !== BOOT_VERSION) {
    throw new Error(`boot: unsupported boot block version ${manifest.version}`);
  }
  if (manifest.fsBlock !== 1) {
    throw new Error(`boot: unsupported filesystem superblock ${manifest.fsBlock}`);
  }
  if (manifest.kernelStart <= manifest.fsBlock || manifest.kernelBlocks <= 0) {
    throw new Error('boot: disk has no installed guest kernel');
  }
  if (manifest.kernelBytes <= 0 || manifest.kernelBytes > manifest.kernelBlocks * BLOCK_SIZE) {
    throw new Error('boot: invalid guest-kernel length');
  }
  const kernelEnd = (manifest.kernelStart + manifest.kernelBlocks) * BLOCK_SIZE;
  if (kernelEnd > diskImage.length) {
    throw new Error('boot: guest-kernel region extends past the disk image');
  }
  if (manifest.kernelStack <= 0) throw new Error('boot: invalid guest-kernel stack');
  return manifest;
}

export function bootGuestDiskImage(
  diskImage: Uint8Array,
  options: GuestBootOptions = {},
): BootedGuest {
  const manifest = readGuestBootBlock(diskImage);
  const physSize = options.physSize ?? GUEST_KERNEL_LAYOUT.physSize;
  if (manifest.kernelLoad + manifest.kernelBytes > physSize) {
    throw new Error('boot: guest kernel does not fit in physical memory');
  }
  if (
    manifest.kernelEntry < manifest.kernelLoad ||
    manifest.kernelEntry >= manifest.kernelLoad + manifest.kernelBytes
  ) {
    throw new Error('boot: guest-kernel entry is outside its image');
  }
  if (manifest.kernelStack > physSize) {
    throw new Error('boot: guest-kernel stack is outside physical memory');
  }

  const machine = new Machine({ ...options, physSize, diskImage });
  const kernelOffset = manifest.kernelStart * BLOCK_SIZE;
  machine.load(
    manifest.kernelLoad,
    diskImage.subarray(kernelOffset, kernelOffset + manifest.kernelBytes),
  );
  machine.reset({ pc: manifest.kernelEntry, sp: manifest.kernelStack });
  return { machine, manifest };
}
