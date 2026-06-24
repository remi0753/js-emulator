// Version-independent block storage contract.

export const BLOCK_SIZE = 512;
export const BSIZE = BLOCK_SIZE;

export interface BlockDevice {
  readonly blocks: number;
  read(block: number): Uint8Array;
  write(block: number, data: Uint8Array): void;
}
