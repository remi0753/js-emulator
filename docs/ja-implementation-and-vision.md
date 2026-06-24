# jscpu-os 日本語詳細レポート

このドキュメントは、現時点でこのプロジェクトに実装されている内容と、
これから目指す方向性を日本語で整理したものです。

特に重要なテーマは次の 3 つです。

1. いまの v1 / v2 で何ができているのか。
2. v2 と現実の Linux は何が違うのか。
3. 今後、Node.js 上の VM で Linux-like な guest OS を育てるには、どの順番で何を作るべきか。

結論から言うと、現状の v2 は「TypeScript 製カーネルが、仮想 CPU / MMU / disk / filesystem / process model を制御して、guest userland を実行する」段階まで到達しています。

次の大きな目標は、TypeScript を「カーネル」ではなく「仮想ハードウェア」へ押し下げ、OS カーネル自身を guest code として VM 上で実行することです。

そのうえで、Linux と同じものをそのまま再実装するのではなく、Linux の重要な概念を借りながら、教育的で観察しやすく、実験しやすい Linux-like guest OS を作っていく方針が現実的です。

---

## 1. プロジェクト全体の考え方

このプロジェクトの中心にある考え方は、**CPU と OS の境界を自分で設計する**ことです。

普通の OS 開発では、CPU、割り込み、MMU、デバイス、boot firmware などは既に存在しており、OS はそれらに合わせて作ります。

一方、このプロジェクトでは、CPU も OS も TypeScript / JavaScript の世界で実装されています。そのため、CPU がどのタイミングでホスト JavaScript に制御を返すか、syscall や trap をどう表現するか、process の状態をどこに保存するか、といった境界を自分で決められます。

最初の v1 では、この境界をとても単純にしました。

```text
user program bytecode
        |
        v
virtual CPU
        |
        v
TypeScript OS scheduler
```

CPU は `run(maxCycles)` を実行し、一定命令数を実行したら必ず TypeScript 側へ戻ります。これにより、実ハードウェアの timer interrupt の代わりに、TypeScript OS が process を切り替えられます。

v2 では、この仕組みを発展させ、paging MMU、user/kernel privilege、port I/O、filesystem、fork/exec/wait、shell まで持つ Unix-like OS に広げています。

---

## 2. 現在の実装状況

### 2.1 共通基盤: ISA と assembler

共通の命令セットは `src/isa.ts` に定義されています。

特徴は次の通りです。

- 32-bit register machine
- 汎用レジスタ `R0` から `R7`
- `PC`, `SP`, `FLAGS`
- little-endian
- 可変長 instruction encoding
- `MOV`, `LOAD`, `STORE`, `ADD`, `SUB`, `JMP`, `CALL`, `RET` などの基本命令
- `INT` による syscall / trap
- v2 用の `IN` / `OUT` port I/O
- v2 userland の文字列処理用 `LB` / `SB`

assembler は `src/assembler.ts` にあり、assembly source を bytecode に変換します。

ラベル解決、即値、文字リテラル、`.word`、`.string` などを扱えます。

この「ISA table を CPU と assembler が共有する」設計は重要です。命令の opcode や operand layout が一箇所にまとまっているため、CPU と assembler の理解がずれにくくなっています。

---

### 2.2 v1: 最小の preemptive OS

v1 は `src/v1/` にあります。

v1 の目的は、**最小構成で preemptive multitasking を成立させる**ことです。

実装されているもの:

- register machine CPU
- process ごとの独立した `Uint8Array` memory image
- PCB
- round-robin scheduler
- `EXIT`, `WRITE`, `YIELD`, `GETPID`, `SPAWN`, `SLEEP`
- `run(maxCycles)` による quantum 切れ
- CPU-bound process の preemption

v1 には MMU も privilege も device もありません。

その代わり、process ごとに別々の memory image を持たせ、context switch 時に CPU の memory 参照を差し替えます。これは実 CPU らしくはありませんが、process isolation を理解するにはとても単純です。

v1 の価値は、OS の核心である「実行状態を保存し、別の process に切り替える」という仕組みを最小限で見せている点です。

---

### 2.3 v2: Unix-like OS

v2 は `src/v2/` にあります。

v2 は v1 の「CPU がホストへ制御を返す」という発想を残したまま、より本物の OS に近づけたものです。

v2 の構成:

```text
guest userland bytecode
  init, sh, echo, cat, ls
        |
        v
v2 virtual CPU
  USER mode, paging, traps, faults
        |
        v
TypeScript kernel
  scheduler, syscalls, VMM, PMM, FS, process model
        |
        v
virtual hardware
  physical memory, port bus, console, keyboard, disk
```

v2 で特に重要なのは、user program は本当に仮想 CPU の USER mode で動き、memory access は MMU を通るという点です。

user program は kernel memory や他 process の memory を直接触れません。bad pointer を syscall に渡した場合も、kernel は `copyin` / `copyout` で MMU を通して検査し、失敗すれば error を返します。

ただし、v2 の kernel 自体はまだ guest code ではありません。kernel は TypeScript で実装され、CPU が syscall / pagefault / timer などで `run()` から戻ると、TypeScript kernel が処理します。

このモデルを、このプロジェクトでは **model A** と呼べます。

---

## 3. v2 の主要コンポーネント

### 3.1 CPU

v2 が使う custom32 CPU は `src/vm/custom32/cpu.ts` にあります。

主な機能:

- USER / KERNEL mode
- paging enabled flag
- `PTBR`: page table base register
- `PFLA`: page fault linear address
- privileged instruction check
- page fault
- illegal opcode fault
- divide-by-zero fault
- timer quantum
- IRQ
- port I/O

CPU は命令を fetch/decode/execute し、次のような理由で `run()` から戻ります。

- `timer`
- `syscall`
- `pagefault`
- `fault`
- `halt`
- `irq`

v2 では `IN`, `OUT`, `IRET`, `HLT`, `EI`, `DI` などは privileged instruction です。USER mode から実行すると fault になります。

ただし `IRET` はまだ実装されていません。これは今後、kernel 自身が guest code として動く model B で必要になります。

---

### 3.2 MMU

MMU は `src/vm/custom32/mmu.ts` にあります。

特徴:

- 4 KiB page
- x86-32 風 2-level page table
- directory index 10 bit
- table index 10 bit
- page offset 12 bit
- PTE flags: `P`, `W`, `U`, `COW`

`P` は present、`W` は writable、`U` は user accessible、`COW` は copy-on-write 用の software bit です。

USER mode access では `U` bit が必要です。write access では `W` bit も必要です。存在しない page や permission 違反は page fault になります。

---

### 3.3 Physical memory manager

PMM は `src/v2/kernel/pmm.ts` にあります。

実装は単純な free-frame allocator です。

- physical memory は 16 MiB
- 1 MiB 未満は予約領域
- 4 KiB frame 単位で管理
- COW 用に frame refcount を持つ

この PMM はまだ現実 Linux の buddy allocator のような複雑なものではありませんが、fork の copy-on-write を支えるには十分です。

---

### 3.4 Virtual memory manager

VMM は `src/v2/kernel/vmm.ts` にあります。

主な機能:

- address space 作成
- page mapping
- executable segment loading
- COW clone
- COW fault resolution
- address space free
- `copyin`
- `copyout`
- `copyinStr`

特に重要なのは、kernel が user memory を直接 `Uint8Array` として雑に触らず、MMU translation を通して `copyin` / `copyout` している点です。

これは実 OS の user/kernel boundary に近い考え方です。

---

### 3.5 Process model

process model は主に `src/v2/kernel/kernel.ts` と `src/v2/kernel/process.ts` にあります。

実装されているもの:

- PID
- process state
  - `ready`
  - `running`
  - `waiting`
  - `blocked`
  - `zombie`
- parent / children
- wait / zombie reaping
- reparenting to init
- per-process fd table
- saved CPU state
- page directory

syscall としては次が実装されています。

- `EXIT`
- `WRITE`
- `YIELD`
- `GETPID`
- `FORK`
- `EXEC`
- `WAIT`
- `OPEN`
- `CLOSE`
- `READ`
- `PIPE`
- `DUP`
- `UPTIME`

`fork` は copy-on-write です。parent と child は最初同じ physical frame を read-only + COW として共有し、どちらかが write したタイミングで page fault を起こし、kernel が private copy を作ります。

これは Unix-like OS の重要な仕組みです。

---

### 3.6 File descriptors, pipes, blocking I/O

v2 には per-process file descriptor table があります。

fd は次の kind を持ちます。

- console
- file
- pipe

pipe は in-kernel byte FIFO です。

read side が空の pipe を読むと process は block します。writer が data を書くと blocked reader が wake されます。writer が全て閉じられると read は EOF を返します。

keyboard input も blocking read として扱われます。stdin を読む process は、入力がなければ block し、host が `feedInput()` で keyboard に文字を入れると wake されます。

---

### 3.7 Disk device

disk device は `src/vm/custom32/devices/disk.ts` にあります。

特徴:

- 512 byte sector
- backing store は `Uint8Array`
- port-mapped PIO 風 interface
- `DISK_POS`
- `DISK_DATA`
- `DISK_SECTORS`

共有の block-device adapter は `src/storage/port-block-device.ts` にあります。

disk への read/write は port bus 経由で行われます。これは「device driver が port I/O で device を操作する」という仕組みを小さく再現しています。

---

### 3.8 Filesystem

filesystem は `src/storage/fs.ts` にあります。

xv6 風の小さな filesystem です。

構造:

- block 0: boot block 的な予約
- block 1: superblock
- inode blocks
- bitmap blocks
- data blocks

inode:

- type
- nlink
- size
- direct block pointers
- single indirect block pointer

directory entry:

- `inum: u16`
- `name[14]`

実装されている操作:

- `mkfs`
- `mount`
- `ialloc`
- `ifree`
- `balloc`
- `bfree`
- `readi`
- `writei`
- `itrunc`
- `dirLookup`
- `dirLink`
- `readdir`
- `namei`
- `nameiParent`
- `create`
- `mkdir`
- `mkdirp`
- `writeFile`

現時点では journaling、permission、timestamp、symlink、hard link の完全な semantics、VFS mount などはありません。

---

### 3.9 Executable format

executable format は `src/formats/executable.ts` にあります。

独自の minimal ELF-like format です。

header:

- magic
- entry point
- segment count

segment:

- virtual address
- file offset
- file size
- memory size
- flags

kernel は filesystem から executable file を読み、segment ごとに address space へ map し、BSS を zero-fill して USER mode で開始します。

---

### 3.10 Userland

userland は `src/v2/userland/programs.ts` にあります。

現在の userland は手書き assembly です。

実装されている program:

- `/bin/init`
- `/bin/sh`
- `/bin/echo`
- `/bin/cat`
- `/bin/ls`

`init` は `/bin/sh` を exec します。

shell は stdin から line を読み、space で簡易 tokenization し、`fork` して child が `/bin/<cmd>` を exec し、parent が `wait` します。

まだ redirection や job control はありませんが、boot して shell に入り、`ls`, `cat`, `echo` を実行するところまで動きます。

---

## 4. 現在できていること

現在の v2 は、次のことができます。

- user process を USER mode で実行する
- page table による address translation を行う
- user process の bad memory access を page fault として検出する
- user process から privileged instruction を禁止する
- `INT 0x80` で syscall する
- scheduler により複数 process を preempt する
- `fork` / `exec` / `wait` / `exit` を行う
- COW fork を行う
- file descriptor を使う
- pipe と blocking read を使う
- keyboard input で blocked process を wake する
- disk-backed filesystem を mount する
- executable を filesystem から load する
- `/bin/init` から `/bin/sh` に入る
- shell から `ls`, `cat`, `echo` を実行する

実行例として `node demo/v2-shell.ts` があります。

非 TTY では scripted session として次のような流れを確認できます。

```text
boot -> init -> sh -> echo -> ls / -> ls /bin -> cat /README
```

---

## 5. v2 と現実の Linux の違い

v2 は Unix-like な仕組みを多く持っていますが、現実の Linux とはまだ大きく違います。

最も大きな違いは、**v2 の kernel は TypeScript 側で動いている**ことです。

userland は guest bytecode として VM 上で動きます。しかし kernel は guest bytecode ではありません。syscall、page fault、timer などが起きると、CPU の `run()` が TypeScript へ戻り、TypeScript kernel が処理します。

現実の Linux では、kernel も CPU 上の kernel mode で動きます。

比較すると次のようになります。

| 項目 | v2 | 現実の Linux |
|---|---|---|
| CPU | 独自 32-bit register machine | x86_64, ARM64, RISC-V など |
| kernel | TypeScript host code | native kernel mode code |
| userland | guest bytecode | native ELF binaries |
| syscall | `INT 0x80` で TS kernel へ戻る | CPU trap entry で kernel mode へ入る |
| trap return | `run()` 再開 | `iret`, `sret`, `eret` など |
| MMU | 小さな 2-level paging | architecture-specific paging |
| scheduler | round-robin | CFS, RT, deadline, SMP 対応 |
| process | fork/exec/wait/zombie | threads, clone, namespaces, cgroups など |
| signals | 未実装 | 豊富な signal model |
| filesystem | 小さな xv6 風 FS | VFS + ext4/xfs/btrfs/tmpfs/procfs など |
| permissions | ほぼ未実装 | uid/gid/mode/capabilities/LSM |
| network | 未実装 | full network stack |
| device model | fixed port devices | PCI/ACPI/Device Tree/USB/virtio など |
| observability | tests と logs 中心 | `/proc`, `/sys`, tracing, perf など |

v2 は「Linux 互換 OS」ではありません。

より正確には、**Linux / xv6 的な概念を教育的に再現した Unix-like OS**です。

---

## 6. 今後の最重要方針

今後の中心方針は、次の 2 段階です。

1. kernel を TypeScript から guest code へ移す。
2. その guest OS を Linux-like に育てる。

ここでいう Linux-like とは、Linux kernel をそのまま動かすという意味ではありません。

このプロジェクトの ISA は独自 ISA です。そのため、Ubuntu の x86_64 binary や Linux kernel をそのまま動かすことはできません。

Linux kernel や Ubuntu をそのまま動かしたい場合は、RISC-V `virt` や x86_64 PC のような、Linux が対応している実 architecture / platform を emulate する必要があります。それは別の emulator project です。

このプロジェクトの本線は、**custom ISA 上で、Linux に似た設計思想と使い勝手を持つ guest OS を自作する**ことです。

---

## 7. なぜ Linux-like guest OS 路線がよいのか

Linux-like guest OS 路線の最大の利点は、自由度が高いことです。

RISC-V `virt` や x86_64 PC 互換 emulator を作る場合、Linux が期待する仕様に正確に合わせる必要があります。boot firmware、interrupt controller、timer、MMU、device tree、virtio、PCI など、多くの仕様を満たさないと kernel が起動しません。

一方、Linux-like guest OS では、自分たちで OS を設計できます。

自由にできること:

- syscall ABI を整理できる
- Linux の歴史的な複雑さを避けられる
- page fault や COW を見える化できる
- `/proc` を最初から教育的に設計できる
- device を debug しやすい形にできる
- deterministic replay や snapshot を VM の標準機能にできる
- capability security などを早い段階で試せる
- filesystem を差し替えて実験できる
- scheduler policy を切り替えて比較できる

これは、現実 Linux そのものを動かす emulator とは別の面白さです。

Linux kernel を起動する楽しさは「本物が動いた」という楽しさです。

Linux-like guest OS の楽しさは「OS の仕組みを自分で設計し、観察し、変えられる」という楽しさです。

---

## 8. model B: kernel を guest code にする

v2 は model A です。

```text
guest user program
        |
        v
virtual CPU
        |
        v
TypeScript kernel
```

次に目指す model B では、kernel も guest code になります。

```text
guest user program
        |
        v
guest kernel
        |
        v
virtual CPU / MMU / devices
        |
        v
Node.js host
```

このためには、CPU 自体に本物に近い trap entry が必要です。

必要になるもの:

- trap vector table
- kernel stack
- trap frame
- mode switch
- syscall entry
- page fault entry
- interrupt entry
- `IRET` 相当の return
- timer IRQ
- device IRQ

v2 では syscall や page fault が起きると TypeScript kernel へ戻っていました。

model B では、syscall や page fault が起きたとき、CPU が guest kernel の handler に jump し、guest kernel が処理し、`IRET` で user mode へ戻る必要があります。

これは大きな設計変更ですが、ここを越えるとプロジェクトは「TypeScript で OS を模倣している」状態から、「TypeScript で作った machine 上で OS が動いている」状態へ変わります。

---

## 9. 実装ロードマップの考え方

今後の roadmap は、大きく v3, v4, v5 に分かれます。

### v3: guest kernel 化

v3 の目的は、kernel を guest code にすることです。

重要な順番:

1. VM と TypeScript kernel を分離する
2. CPU に trap / interrupt entry を実装する
3. boot path と disk image contract を決める
4. guest kernel 用 toolchain を作る
5. minimal guest kernel を boot する
6. memory management と scheduler を guest kernel に移す
7. syscall と process lifecycle を guest kernel に移す
8. filesystem と storage driver を guest kernel に移す
9. userland を disk image build に統合する
10. device driver boundary を整理する

この順番が重要です。

最初から filesystem や shell を guest kernel に移そうとすると、trap や scheduler が不安定な状態で多くの問題を同時に抱えます。

まずは、guest kernel が trap を受け、timer interrupt を処理し、page fault を扱い、serial output できるところまでを小さく作るのがよいです。

---

### v4: Linux-like OS へ育てる

v4 の目的は、guest kernel が動く状態を土台にして、Linux-like な OS surface を増やすことです。

重要な領域:

- process group
- session
- signal
- job control
- errno
- Linux-shaped syscalls
- uid/gid
- permission
- `stat`
- link / symlink / rename
- VFS
- `/dev`
- `/proc`
- tmpfs
- TTY
- `mmap`
- VMA
- demand paging
- page cache
- libc
- coreutils-like userland
- `poll` / `select`
- socket API
- network stack
- device driver model
- observability

ここでの目標は、Linux と完全互換になることではありません。

目標は、Linux の重要な概念を持ち、Linux に慣れた人が理解しやすく、かつこの VM ならではの観察性と実験性を持つ OS にすることです。

---

### v5: self-hosting と実験環境

v5 は stretch goal です。

目標:

- assembler を guest userland で動かす
- linker を guest userland で動かす
- compiler を guest userland で動かす
- userland program を guest 内で build する
- kernel または kernel module を guest 内で build する
- build した artifact を別 VM boot で検証する

これはかなり先の目標ですが、ここまで到達すると、この OS は単なる demo ではなく、自分自身を育てられる環境になります。

---

## 10. 実験しやすい OS としての設計アイデア

Linux-like guest OS の強みは、現実 Linux では変えにくい部分を自由に設計できることです。

以下は、このプロジェクトで特に面白い実験の方向性です。

### 10.1 syscall ABI をきれいにする

Linux syscall は長い歴史を背負っています。

自作 OS では、より整理された ABI を設計できます。

例:

- syscall result を統一する
- error code を明確にする
- path-based API と fd-based API を分ける
- syscall trace を標準機能にする
- syscall argument の型情報を debug 用に持つ
- feature negotiation を用意する

---

### 10.2 memory management を可視化する

OS 学習で memory management は最も重要な領域の一つです。

この VM なら、次のような機能を最初から入れられます。

- page fault trace
- process ごとの page table dump
- frame refcount 表示
- COW 状態の表示
- VMA 一覧
- `/proc/<pid>/maps`
- lazy allocation の統計
- page cache hit/miss
- deterministic OOM mode

これにより、COW fork や demand paging が何をしているかを実際に観察できます。

---

### 10.3 filesystem を差し替えて比較する

filesystem は設計の違いが現れやすい領域です。

実験例:

- xv6 風 inode FS
- journaling FS
- copy-on-write FS
- log-structured FS
- snapshot 対応 FS
- immutable file support
- append-only file support
- small file optimization
- directory hash

VFS を用意しておけば、同じ userland を複数 FS 上で動かして比較できます。

---

### 10.4 security model を試す

Linux の uid/gid/capabilities は実用的ですが複雑です。

この OS では、教育的にわかりやすい security model を試せます。

例:

- fd を capability として扱う
- process ごとの syscall allowlist
- namespace
- sandbox process
- device access capability
- file capability
- manifest-based permission
- audit log

これは「小さな Linux」ではなく、「Linux の概念を理解したうえで、別の設計を試す」方向です。

---

### 10.5 deterministic replay と snapshot

Node.js VM であることを活かすなら、determinism は大きな武器です。

実験例:

- VM snapshot
- process snapshot
- disk snapshot
- deterministic timer
- deterministic keyboard/network input
- syscall trace replay
- page fault replay
- failing test の time-travel debug

現実 OS では難しいことも、仮想 machine を自分で持っているため実装しやすいです。

---

### 10.6 `/proc` を教育的に設計する

Linux の `/proc` は便利ですが、歴史的に雑多な面もあります。

この OS では、最初から学習用に整理できます。

例:

```text
/proc/1/status
/proc/1/fd
/proc/1/maps
/proc/1/pagetable
/proc/1/syscalls
/proc/mem/frames
/proc/kernel/scheduler
/proc/kernel/interrupts
/proc/fs/mounts
/proc/devices
```

これにより、shell から OS の内部状態を観察できます。

---

## 11. rv64-virt / Ubuntu 起動との関係

別の面白い方向として、RISC-V 64 の `virt` machine を Node.js で emulate し、Ubuntu RISC-V を起動するという路線があります。

これはとても魅力的です。

ただし、これは Linux-like guest OS とは別の種類のプロジェクトです。

比較:

| 観点 | Linux-like guest OS | rv64-virt emulator |
|---|---|---|
| 目的 | OS を自作して育てる | 既存 Linux / Ubuntu を動かす |
| CPU | custom ISA | RISC-V 64 |
| 主導権 | 自分の設計 | RISC-V / Linux の仕様 |
| 自由度 | 高い | 低い |
| 成功条件 | 自作 OS が Linux-like に動く | Ubuntu RISC-V が boot する |
| 面白さ | OS の設計を変えられる | 本物の OS が動く |

Ubuntu を動かしたいなら、x86_64 より RISC-V 64 `virt` の方が現実的です。

しかし、このプロジェクトの本線としては、まず Linux-like guest OS を育てる方が教育的価値が高く、実験もしやすいです。

将来的には、別 backend として `rv64-virt` emulator を作るのは良い stretch goal です。

---

## 12. 直近で実装するなら何から始めるべきか

直近で最も重要なのは、**VM と TypeScript kernel の分離**です。

現在の `Kernel` は、hardware setup、device setup、scheduler、syscall、filesystem、process table をまとめて持っています。

model B へ進むには、まず次を分ける必要があります。

```text
Machine
  CPU
  PhysicalMemory
  MMU
  PortBus
  Devices
  IRQ state
  reset/load/run

Kernel
  v2 compatibility kernel
  scheduler
  syscalls
  VFS
  process table
```

この分離ができると、次の作業がやりやすくなります。

- guest kernel boot
- hardware-only tests
- trap entry implementation
- deterministic trace
- disk image boot
- v2 compatibility の維持

Phase 7 は地味ですが、今後の全ての基礎になります。

---

## 13. まとめ

このプロジェクトは、すでに v2 でかなり多くの Unix-like OS の要素を実装しています。

できていること:

- virtual CPU
- assembler
- preemptive scheduling
- paging MMU
- user/kernel protection
- syscalls
- process model
- COW fork
- exec from filesystem
- file descriptors
- pipes
- blocking keyboard input
- disk-backed filesystem
- shell
- basic userland

ただし、現実の Linux と比べると、kernel が guest code ではない、signals がない、VFS が小さい、permissions が薄い、network がない、device model が単純、といった差があります。

今後の方向性は明確です。

まず v3 で、TypeScript を kernel から hardware layer へ押し下げます。

次に v4 で、guest kernel に Linux-like な process, signal, VFS, memory management, device, userland を足していきます。

最後に v5 で、self-hosting や実験環境としての完成度を上げます。

この順番で進めると、単に OS 機能が増えるだけでなく、**Node.js 上で動く、観察しやすく、壊しやすく、直しやすく、実験しやすい OS 研究環境**になります。

それがこのプロジェクトの一番面白い到達点です。
