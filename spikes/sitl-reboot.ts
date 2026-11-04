// Reboot SITL from a second link and wait until it's back.
import { MavConnection } from "../packages/vehicle/src/index.ts";
import { tcpTransport } from "../packages/vehicle/src/tcpTransport.ts";
const port = Number(process.argv[2] ?? 5762);
const c = new MavConnection(await tcpTransport("127.0.0.1", port));
await c.ready(8000);
await c.command(246, [1]).catch(() => {});
await c.close();
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { const n = new MavConnection(await tcpTransport("127.0.0.1", port, 1500)); await n.ready(3000); await n.close(); console.log("back after", i + 1, "s"); process.exit(0); } catch { /* not yet */ }
}
console.log("did not come back"); process.exit(1);
