import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OS } from '../src/os.ts';

// 出力を文字列に集めるだけの OS を作るヘルパ。
function makeOS(quantum = 1000) {
  const events: string[] = [];
  const os = new OS({ quantum, onWrite: (c) => events.push(c), log: () => {} });
  return { os, events };
}

test('プリエンプション: クォンタムで CPU 専有プロセスが交互に進む', () => {
  // 各プロセスは「重い計算 (NOP の連続) → 1 文字出力」を繰り返す。
  // syscall を挟まないので、小さいクォンタムでの強制プリエンプションが
  // 起きないと一方が CPU を独占してしまう。
  const heavyPrinter = (ch: string) => `
      MOV R7, 0
      MOV R6, 1
      MOV R5, 3          ; 3 回出力
    outer:
      CMP R5, R7
      JZ  done
      MOV R4, 200        ; 内側ループ回数 (計算で時間を使う)
    inner:
      DEC R4
      CMP R4, R7
      JNZ inner
      MOV R0, 1          ; WRITE
      MOV R1, '${ch}'
      INT 0x80
      SUB R5, R6
      JMP outer
    done:
      MOV R0, 0          ; EXIT
      MOV R1, 0
      INT 0x80
  `;

  const { os, events } = makeOS(50); // 50 命令で強制プリエンプション
  os.spawn(os.loadProgram('A', heavyPrinter('A')));
  os.spawn(os.loadProgram('B', heavyPrinter('B')));
  os.run();

  const out = events.join('');
  assert.equal(out.length, 6, '各プロセス 3 文字ずつ計 6 文字');
  // 両方が進んでいる (片方が独占していない)
  assert.equal([...out].filter((c) => c === 'A').length, 3);
  assert.equal([...out].filter((c) => c === 'B').length, 3);
  // 少なくとも 1 回は A と B が隣り合って入れ替わる = インターリーブの証拠
  assert.ok(/AB|BA/.test(out), `インターリーブしているはず: ${out}`);
});

test('EXIT: 終了コードが PCB に記録される', () => {
  const { os } = makeOS();
  os.spawn(
    os.loadProgram(
      'exit42',
      `
      MOV R0, 0
      MOV R1, 42
      INT 0x80
    `,
    ),
  );
  os.run();
  const pcb = os.processes.get(1)!;
  assert.equal(pcb.state, 'terminated');
  assert.equal(pcb.exitCode, 42);
});

test('GETPID: R0 に自分の PID が入る', () => {
  const { os, events } = makeOS();
  // GETPID して PID を文字コードとみなして出力する。
  os.spawn(
    os.loadProgram(
      'pid',
      `
      MOV R0, 3          ; GETPID
      INT 0x80           ; R0 = pid (=1)
      MOVR R1, R0        ; 出力用に退避
      MOV R0, 1          ; WRITE
      INT 0x80
      MOV R0, 0          ; EXIT
      INT 0x80
    `,
    ),
  );
  os.run();
  assert.equal(events.join('').charCodeAt(0), 1); // pid 1
});

test('SPAWN: 親が子プロセスを生成し両方が出力する', () => {
  const { os, events } = makeOS();
  const child = os.loadProgram(
    'child',
    `
      MOV R0, 1
      MOV R1, 'C'
      INT 0x80
      MOV R0, 0
      INT 0x80
  `,
  );
  const parent = os.loadProgram(
    'parent',
    `
      MOV R0, 4          ; SPAWN
      MOV R1, ${child}   ; プログラム ID
      INT 0x80           ; R0 = 子 PID
      MOV R0, 1          ; WRITE
      MOV R1, 'P'
      INT 0x80
      MOV R0, 0          ; EXIT
      INT 0x80
  `,
  );
  os.spawn(parent);
  os.run();
  const out = events.join('');
  assert.ok(out.includes('P'), '親が出力');
  assert.ok(out.includes('C'), '子が出力');
  assert.equal(os.processes.size, 2, '親 + 子 = 2 プロセス');
});

test('SLEEP: 寝ている間に他プロセスが進む', () => {
  const { os, events } = makeOS();
  // sleeper は出力 → 長く寝る → 出力。busy はその間に複数回出力。
  os.spawn(
    os.loadProgram(
      'sleeper',
      `
      MOV R0, 1
      MOV R1, 'S'
      INT 0x80
      MOV R0, 5          ; SLEEP
      MOV R1, 100        ; 100 ティック
      INT 0x80
      MOV R0, 1
      MOV R1, 'S'
      INT 0x80
      MOV R0, 0
      INT 0x80
  `,
    ),
  );
  os.spawn(
    os.loadProgram(
      'busy',
      `
      MOV R7, 0
      MOV R6, 1
      MOV R5, 3
    loop:
      CMP R5, R7
      JZ  done
      MOV R0, 1
      MOV R1, 'b'
      INT 0x80
      SUB R5, R6
      MOV R0, 2          ; YIELD
      INT 0x80
      JMP loop
    done:
      MOV R0, 0
      INT 0x80
  `,
    ),
  );
  os.run();
  const out = events.join('');
  // sleeper の 2 つの 'S' の間に busy の 'b' が挟まる。
  const first = out.indexOf('S');
  const last = out.lastIndexOf('S');
  assert.ok(last > first, 'S が 2 回出る');
  assert.ok(out.slice(first + 1, last).includes('b'), `寝ている間に b が出るはず: ${out}`);
});
