// Browser transport to tools/bridge.ts (SITL or a serial port behind a local WebSocket).
import type { Transport } from "./transport.ts";

export function wsTransport(url = "ws://127.0.0.1:5770", timeoutMs = 4000): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    let dataCb: (b: Uint8Array) => void = () => {};
    let closeCb: (e?: Error) => void = () => {};
    let opened = false;
    const timer = setTimeout(() => { ws.close(); reject(new Error(`no bridge at ${url}`)); }, timeoutMs);
    ws.onmessage = (ev) => dataCb(new Uint8Array(ev.data as ArrayBuffer));
    ws.onclose = (ev) => {
      clearTimeout(timer);
      if (!opened) reject(new Error(`bridge refused: ${ev.reason || "is tools/bridge.ts running?"}`));
      else closeCb(ev.reason ? new Error(ev.reason) : undefined);
    };
    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        description: `bridge:${url}`,
        write: async (bytes) => ws.send(bytes),
        onData: (cb) => { dataCb = cb; },
        onClose: (cb) => { closeCb = cb; },
        close: async () => ws.close(),
      });
    };
  });
}
