/**
 * Dev bridge: pipes raw MAVLink bytes between a WebSocket (the browser app) and either
 * SITL over TCP or a serial port. Browsers can't open TCP sockets, so this is how the web
 * app talks to SITL during development and in tests.
 *
 *   npx tsx tools/bridge.ts --tcp 127.0.0.1:5760      (SITL)
 *   npx tsx tools/bridge.ts --serial COM9             (a real board, if Web Serial isn't available)
 *   options: --port 5770 (WebSocket port, localhost only)
 *
 * One client at a time; a new client replaces the old one.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { tcpTransport } from "../packages/vehicle/src/tcpTransport.ts";
import { nodeSerialTransport } from "../packages/vehicle/src/nodeSerialTransport.ts";
import type { Transport } from "../packages/vehicle/src/transport.ts";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const wsPort = Number(opt("--port") ?? 5770);
const tcp = opt("--tcp");
const serial = opt("--serial");
if (!tcp && !serial) { console.error("usage: bridge.ts --tcp host:port | --serial COMx [--port 5770]"); process.exit(2); }

async function openVehicle(): Promise<Transport> {
  if (tcp) { const [h, p] = tcp.split(":"); return tcpTransport(h!, Number(p)); }
  return nodeSerialTransport(serial!);
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: wsPort });
let client: WebSocket | undefined;
let vehicle: Transport | undefined;

wss.on("connection", async (ws) => {
  client?.close();
  client = ws;
  console.log(`client connected; opening ${tcp ? "tcp " + tcp : "serial " + serial}`);
  try {
    await vehicle?.close();
    vehicle = await openVehicle();
  } catch (e) {
    console.log(`vehicle open failed: ${(e as Error).message}`);
    ws.close(1011, (e as Error).message.slice(0, 100));
    return;
  }
  const v = vehicle;
  v.onData((b) => { if (client === ws && ws.readyState === ws.OPEN) ws.send(b); });
  v.onClose(() => { if (client === ws) ws.close(1011, "vehicle link closed"); });
  ws.on("message", (data) => { void v.write(new Uint8Array(data as Buffer)); });
  ws.on("close", () => {
    if (client === ws) { client = undefined; void v.close(); vehicle = undefined; }
    console.log("client disconnected");
  });
});
console.log(`bridge listening on ws://127.0.0.1:${wsPort}`);
