import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CPU, MEM_SIZE, type Context } from '../src/cpu.ts';
import { assemble } from '../src/assembler.ts';
import { FLAG, SYSCALL_INT } from '../src/isa.ts';

// アセンブルして 1 プロセス分のコンテキストを作るヘルパ。
function makeContext(source: string): Context {
  const { bytes } = assemble(source);
  const mem = new Uint8Array(MEM_SIZE);
  mem.set(bytes, 0);
  return { regs: new Array(8).fill(0), pc: 0, sp: MEM_SIZE, flags: 0, mem };
}

test('算術: ADD / SUB / MUL とフラグ', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 20
      MOV R1, 22
      ADD R0, R1      ; R0 = 42
      MOV R2, 2
      MUL R0, R2      ; R0 = 84
      MOV R3, 84
      SUB R0, R3      ; R0 = 0 -> ZF
      HLT
    `),
  );
  const r = cpu.run(1000);
  assert.equal(r.reason, 'halt');
  assert.equal(cpu.regs[0], 0);
  assert.ok((cpu.flags & FLAG.ZF) !== 0, 'ZF が立つべき');
});

test('分岐: ループで 1+2+...+5 = 15 を計算', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 0       ; 合計
      MOV R1, 1       ; カウンタ
      MOV R2, 5       ; 上限
      MOV R3, 1       ; 定数 1
    loop:
      ADD R0, R1      ; sum += i
      CMP R1, R2      ; i - 5
      JZ done         ; i == 5 なら終了
      ADD R1, R3      ; i++
      JMP loop
    done:
      HLT
    `),
  );
  const r = cpu.run(10000);
  assert.equal(r.reason, 'halt');
  assert.equal(cpu.regs[0], 15);
});

test('符号付き分岐: JL / JG', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 3
      MOV R1, 10
      CMP R0, R1      ; 3 - 10 < 0 -> SF
      JL less
      MOV R2, 100     ; 通らない
      HLT
    less:
      MOV R2, 7
      HLT
    `),
  );
  cpu.run(1000);
  assert.equal(cpu.regs[2], 7);
});

test('WRITE 相当: INT 0x80 で停止し R0/R1 を読める', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 1       ; syscall WRITE
      MOV R1, 'A'     ; 文字
      INT 0x80
      HLT
    `),
  );
  const r = cpu.run(1000);
  assert.equal(r.reason, 'int');
  assert.equal(r.reason === 'int' && r.int, SYSCALL_INT);
  assert.equal(cpu.regs[0], 1);
  assert.equal(cpu.regs[1], 'A'.charCodeAt(0));
  // INT の後ろから再開できる
  const r2 = cpu.run(1000);
  assert.equal(r2.reason, 'halt');
});

test('スタック: PUSH / POP / CALL / RET', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 0
      MOV R1, 5
      CALL addfive    ; R0 += 5
      CALL addfive    ; R0 += 5
      HLT
    addfive:
      ADD R0, R1
      RET
    `),
  );
  const r = cpu.run(1000);
  assert.equal(r.reason, 'halt');
  assert.equal(cpu.regs[0], 10);
});

test('クォンタム: maxCycles 到達で reason=quantum', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
    spin:
      NOP
      JMP spin
    `),
  );
  const r = cpu.run(50);
  assert.equal(r.reason, 'quantum');
});

test('フォルト: 0 除算と不正オペコード', () => {
  const cpu = new CPU();
  cpu.loadContext(
    makeContext(`
      MOV R0, 10
      MOV R1, 0
      DIV R0, R1
      HLT
    `),
  );
  const r = cpu.run(1000);
  assert.equal(r.reason, 'fault');

  // 不正オペコード (0xEE は未定義)
  const ctx: Context = {
    regs: new Array(8).fill(0),
    pc: 0,
    sp: MEM_SIZE,
    flags: 0,
    mem: new Uint8Array(MEM_SIZE),
  };
  ctx.mem[0] = 0xee;
  const cpu2 = new CPU();
  cpu2.loadContext(ctx);
  assert.equal(cpu2.run(10).reason, 'fault');
});

test('コンテキスト切替: save/load で 2 つの状態を保持', () => {
  const cpu = new CPU();
  const a = makeContext(`spin: ADD R0, R1\nJMP spin`);
  a.regs[1] = 1; // A は R0 を +1 し続ける
  const b = makeContext(`spin: ADD R0, R1\nJMP spin`);
  b.regs[1] = 10; // B は R0 を +10 し続ける

  for (let i = 0; i < 3; i++) {
    cpu.loadContext(a);
    cpu.run(4);
    cpu.saveContext(a);

    cpu.loadContext(b);
    cpu.run(4);
    cpu.saveContext(b);
  }
  // それぞれ独立に積算されている
  assert.ok(a.regs[0]! > 0);
  assert.ok(b.regs[0]! > a.regs[0]!);
});
