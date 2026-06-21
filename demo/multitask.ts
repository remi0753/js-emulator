// デモ (DESIGN §9-5): 2 つのプロセスを交互に動かし、コンソール出力が
// インターリーブすることを確認する = プリエンプティブ・マルチタスクの成立。
//
// 各プロセスは自分の文字を 5 回出力する。1 回出力するごとに YIELD して
// CPU を手放すので、A B A B ... のように混ざって出力される。
//
// 実行: npm run demo  (= node demo/multitask.ts)

import { OS } from '../src/v1/os.ts';

// 引数 'X' の文字を count 回、毎回 YIELD しながら出力するプログラム。
function printer(char: string, count: number): string {
  return `
      MOV R4, '${char}'   ; 出力する文字
      MOV R5, ${count}    ; 残り回数
      MOV R6, 1           ; 定数 1
      MOV R7, 0           ; 定数 0 (syscall で壊れない比較用)
    loop:
      CMP R5, R7          ; 残り == 0 か判定
      JZ  done
      MOV R0, 1           ; syscall WRITE
      MOVR R1, R4
      INT 0x80
      SUB R5, R6          ; 残り--
      MOV R0, 2           ; syscall YIELD
      INT 0x80
      JMP loop
    done:
      MOV R0, 0           ; syscall EXIT
      MOV R1, 0
      INT 0x80
  `;
}

const os = new OS({
  quantum: 1000, // YIELD で手放すので実際にはこの上限には届かない
  onWrite: (c, pcb) => process.stdout.write(`${pcb.name}:${c}  `),
  log: (m) => console.log(`[kernel] ${m}`),
});

const progA = os.loadProgram('A', printer('A', 5));
const progB = os.loadProgram('B', printer('B', 5));

os.spawn(progA);
os.spawn(progB);

console.log('=== プリエンプティブ・マルチタスク デモ ===');
console.log('2 プロセス (A, B) が YIELD しながら交互に出力します:\n');
os.run();

console.log('\n\n=== 完了 ===');
console.log('生の出力列:', JSON.stringify(os.output));
for (const pcb of os.processes.values()) {
  console.log(`  pid=${pcb.pid} name=${pcb.name} state=${pcb.state} exit=${pcb.exitCode}`);
}
