import { MavConnection } from "../packages/vehicle/src/index.ts";
import { tcpTransport } from "../packages/vehicle/src/tcpTransport.ts";
const conn = new MavConnection(await tcpTransport("127.0.0.1", 5760));
await conn.ready();
console.log("disarm result", await conn.command(400, [0]));
await new Promise((r) => setTimeout(r, 1500));
console.log("armed now?", conn.armed);
await conn.command(42701, [3]).catch(() => {});
await conn.close();
