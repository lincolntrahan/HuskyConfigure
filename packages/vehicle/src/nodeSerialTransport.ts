// Node-only serial transport (spikes, CLI tools, Electron main). The web app uses Web Serial.
import { SerialPort } from "serialport";
import type { Transport } from "./transport.ts";

export function nodeSerialTransport(path: string, baudRate = 115200): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    let dataCb: (b: Uint8Array) => void = () => {};
    let closeCb: (e?: Error) => void = () => {};
    port.on("data", (b: Buffer) => dataCb(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
    port.on("close", (e?: Error) => closeCb(e));
    port.open((err) => {
      if (err) return reject(err);
      resolve({
        description: `serial:${path}`,
        write: (bytes) => new Promise((res, rej) => port.write(Buffer.from(bytes), (e) => (e ? rej(e) : res()))),
        onData: (cb) => { dataCb = cb; },
        onClose: (cb) => { closeCb = cb; },
        close: () => new Promise((res) => (port.isOpen ? port.close(() => res()) : res())),
      });
    });
  });
}
