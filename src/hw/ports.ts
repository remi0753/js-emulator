// ポート I/O バス (v2)。デバイスを固定ポート番号に接続する。
//
// CPU の特権命令 IN/OUT と、TS カーネルのドライバの両方がこの同じバスを
// 通じてデバイスを操作する (= ポート I/O の機構を端から端まで使う)。

export interface PortDevice {
  // ポートからの読み出し (IN)。32bit 値を返す。
  read?(port: number): number;
  // ポートへの書き込み (OUT)。
  write?(port: number, value: number): void;
}

export class PortBus {
  // port 番号 -> デバイス
  private readers = new Map<number, PortDevice>();
  private writers = new Map<number, PortDevice>();

  // [base, base+count) のポート範囲にデバイスを割り当てる。
  register(base: number, count: number, device: PortDevice): void {
    for (let p = base; p < base + count; p++) {
      if (device.read) this.readers.set(p, device);
      if (device.write) this.writers.set(p, device);
    }
  }

  in(port: number): number {
    const dev = this.readers.get(port);
    if (!dev?.read) throw new PortError(`未接続ポートからの IN: 0x${port.toString(16)}`);
    return dev.read(port) >>> 0;
  }

  out(port: number, value: number): void {
    const dev = this.writers.get(port);
    if (!dev?.write) throw new PortError(`未接続ポートへの OUT: 0x${port.toString(16)}`);
    dev.write(port, value >>> 0);
  }
}

export class PortError extends Error {}
