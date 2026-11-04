// Browser (Chrome/Edge, Electron) transport over the Web Serial API.
import type { Transport } from "./transport.ts";

// Minimal Web Serial typings (not in TypeScript's DOM lib).
export interface WebSerialPort {
  open(opts: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}
interface WebSerial {
  requestPort(opts?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }): Promise<WebSerialPort>;
  getPorts(): Promise<WebSerialPort[]>;
}
export function webSerial(): WebSerial | undefined {
  return (globalThis.navigator as unknown as { serial?: WebSerial } | undefined)?.serial;
}

/** USB vendor ids used by ArduPilot boards (ArduPilot's pid.codes id, plus common ones). */
export const ARDUPILOT_USB_FILTERS = [{ usbVendorId: 0x1209 }, { usbVendorId: 0x2dae }, { usbVendorId: 0x26ac }, { usbVendorId: 0x0483 }];

/** Ask the user to pick a port (must be called from a click handler). */
export async function requestSerialPort(): Promise<WebSerialPort> {
  const serial = webSerial();
  if (!serial) throw new Error("This browser has no Web Serial. Use Chrome or Edge, or the desktop app.");
  return serial.requestPort({ filters: ARDUPILOT_USB_FILTERS });
}

export async function webSerialTransport(port: WebSerialPort, baudRate = 115200): Promise<Transport> {
  await port.open({ baudRate, bufferSize: 16384 });
  const writer = port.writable!.getWriter();
  const reader = port.readable!.getReader();
  let dataCb: (b: Uint8Array) => void = () => {};
  let closeCb: (e?: Error) => void = () => {};
  let closed = false;

  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) dataCb(value);
      }
      if (!closed) closeCb();
    } catch (e) {
      if (!closed) closeCb(e as Error); // e.g. board rebooted / unplugged
    }
  })();

  const info = port.getInfo();
  return {
    description: `usb:${(info.usbVendorId ?? 0).toString(16)}:${(info.usbProductId ?? 0).toString(16)}`,
    write: (bytes) => writer.write(bytes),
    onData: (cb) => { dataCb = cb; },
    onClose: (cb) => { closeCb = cb; },
    close: async () => {
      closed = true;
      try { await reader.cancel(); } catch { /* already gone */ }
      reader.releaseLock();
      writer.releaseLock();
      try { await port.close(); } catch { /* already gone */ }
    },
  };
}
