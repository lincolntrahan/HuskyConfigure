// Node-only transport, used for SITL in tests and spikes. Not bundled into the web app.
import { connect, type Socket } from "node:net";
import type { Transport } from "./transport.ts";

export function tcpTransport(host: string, port: number, timeoutMs = 5000): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect({ host, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`TCP ${host}:${port} timed out`)); }, timeoutMs);
    let dataCb: (b: Uint8Array) => void = () => {};
    let closeCb: (e?: Error) => void = () => {};
    sock.on("data", (b) => dataCb(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
    sock.on("close", () => closeCb());
    sock.on("error", (e) => { clearTimeout(timer); closeCb(e); reject(e); });
    sock.on("connect", () => {
      clearTimeout(timer);
      sock.setNoDelay(true);
      resolve({
        description: `tcp:${host}:${port}`,
        write: (bytes) => new Promise((res, rej) => sock.write(bytes, (e) => (e ? rej(e) : res()))),
        onData: (cb) => { dataCb = cb; },
        onClose: (cb) => { closeCb = cb; },
        close: async () => { sock.destroy(); },
      });
    });
  });
}
