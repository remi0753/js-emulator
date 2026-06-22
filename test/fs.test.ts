import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BlockDisk } from '../src/vm/custom32/devices/disk.ts';
import { PortBus } from '../src/vm/custom32/ports.ts';
import { PORT } from '../src/v2/kernel/abi.ts';
import { BlockDriver, BSIZE } from '../src/v2/kernel/disk.ts';
import { Fs, MAXFILE, NDIRECT, ROOTINO, T_DIR, T_FILE } from '../src/v2/kernel/fs.ts';

function newDisk(sectors = 2048) {
  const ports = new PortBus();
  const disk = BlockDisk.blank(sectors);
  ports.register(PORT.DISK_DATA, 1, disk);
  ports.register(PORT.DISK_POS, 1, disk);
  ports.register(PORT.DISK_SECTORS, 1, disk);
  return new BlockDriver(ports);
}

function newFs(sectors = 2048) {
  const fs = new Fs(newDisk(sectors));
  fs.mkfs();
  return fs;
}

function bytes(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}
function str(b: Uint8Array): string {
  return String.fromCharCode(...b);
}

test('block driver: sector write/read round-trips', () => {
  const disk = newDisk();
  const buf = new Uint8Array(BSIZE);
  for (let i = 0; i < BSIZE; i++) buf[i] = (i * 7) & 0xff;
  disk.write(5, buf);
  assert.deepEqual([...disk.read(5)], [...buf]);
  // A different block is still zero.
  assert.deepEqual([...disk.read(6)], [...new Uint8Array(BSIZE)]);
});

test('mkfs creates a mountable root directory with . and ..', () => {
  const fs = newFs();
  const root = fs.readInode(ROOTINO);
  assert.equal(root.type, T_DIR);
  assert.equal(fs.dirLookup(ROOTINO, '.'), ROOTINO);
  assert.equal(fs.dirLookup(ROOTINO, '..'), ROOTINO);
  assert.deepEqual(
    fs
      .readdir(ROOTINO)
      .map((e) => e.name)
      .sort(),
    ['.', '..'],
  );
});

test('mount reads back the superblock written by mkfs', () => {
  const disk = newDisk();
  const a = new Fs(disk);
  a.mkfs();
  // A second Fs over the same disk can mount and see the root.
  const b = new Fs(disk);
  b.mount();
  assert.equal(b.namei('/'), ROOTINO);
});

test('create + write + read a small file', () => {
  const fs = newFs();
  fs.writeFile('/hello.txt', bytes('hello world'));
  const inum = fs.namei('/hello.txt');
  assert.notEqual(inum, 0);
  assert.equal(fs.readInode(inum).type, T_FILE);
  assert.equal(str(fs.readFile(inum)), 'hello world');
});

test('nested directories via mkdirp and path lookup', () => {
  const fs = newFs();
  fs.writeFile('/bin/echo', bytes('ECHO'));
  assert.notEqual(fs.namei('/bin'), 0);
  assert.equal(fs.readInode(fs.namei('/bin')).type, T_DIR);
  assert.equal(str(fs.readFile(fs.namei('/bin/echo'))), 'ECHO');
  assert.equal(fs.namei('/bin/missing'), 0);
});

test('a file spanning direct + indirect blocks reads back intact', () => {
  const fs = newFs();
  // Bigger than NDIRECT blocks so the indirect block is exercised.
  const n = (NDIRECT + 5) * BSIZE + 123;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = (i * 31 + 7) & 0xff;
  fs.writeFile('/big', data);
  const got = fs.readFile(fs.namei('/big'));
  assert.equal(got.length, n);
  assert.deepEqual([...got], [...data]);
});

test('partial reads at an offset are clamped to the file size', () => {
  const fs = newFs();
  fs.writeFile('/f', bytes('0123456789'));
  const din = fs.readInode(fs.namei('/f'));
  assert.equal(str(fs.readi(din, 3, 4)), '3456');
  assert.equal(str(fs.readi(din, 8, 100)), '89'); // clamped
  assert.equal(fs.readi(din, 20, 4).length, 0); // past EOF
});

test('truncate frees blocks (no leak across rewrite)', () => {
  const fs = newFs(256);
  // Fill a chunk, then rewrite smaller many times; should not exhaust the disk.
  for (let i = 0; i < 50; i++) {
    fs.writeFile('/tmp', new Uint8Array((NDIRECT + 2) * BSIZE).fill(i & 0xff));
  }
  fs.writeFile('/tmp', bytes('final'));
  assert.equal(str(fs.readFile(fs.namei('/tmp'))), 'final');
});

test('overwriting a directory entry name is rejected', () => {
  const fs = newFs();
  fs.mkdir('/d');
  assert.throws(() => fs.mkdir('/d'));
});

test('readdir lists created entries', () => {
  const fs = newFs();
  fs.writeFile('/a', bytes('a'));
  fs.writeFile('/b', bytes('b'));
  fs.mkdir('/c');
  assert.deepEqual(
    fs
      .readdir(ROOTINO)
      .map((e) => e.name)
      .sort(),
    ['.', '..', 'a', 'b', 'c'],
  );
});

test('MAXFILE bound is enforced', () => {
  const fs = newFs(4096);
  const din = fs.readInode(fs.create('/x', T_FILE));
  assert.throws(() => fs.writei(fs.namei('/x'), din, MAXFILE * BSIZE, bytes('!')));
});
