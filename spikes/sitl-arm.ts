// Arm or disarm SITL from a second link (SITL SERIAL1 = TCP 5762) while the app is on SERIAL0.
import { MavConnection } from "../packages/vehicle/src/index.ts";
import { tcpTransport } from "../packages/vehicle/src/tcpTransport.ts";
const arm = process.argv[2] !== "disarm";
const conn = new MavConnection(await tcpTransport("127.0.0.1", Number(process.argv[3] ?? 5762)));
await conn.ready(8000);
console.log(`${arm ? "arm" : "disarm"} result`, await conn.command(400, [arm ? 1 : 0]));
await new Promise((r) => setTimeout(r, 1500));
console.log("armed now:", conn.armed);
await conn.close();
