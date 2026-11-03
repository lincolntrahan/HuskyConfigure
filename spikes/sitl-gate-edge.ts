/**
 * Phase 0 spike: edge cases for husky.lua (run after sitl-failsafe.ts has configured SITL).
 *   A. Total failsafe latency with HSK_FS_DLY=0 (ArduPilot's own RC_FS_TIMEOUT only).
 *   B. Script stops while the gate is PASSING: can the vehicle still arm?
 */
import { MavConnection, ParamManager } from "../packages/vehicle/src/index.ts";
import { tcpTransport } from "../packages/vehicle/src/tcpTransport.ts";
import { configHash } from "../packages/profile/src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conn = new MavConnection(await tcpTransport("127.0.0.1", 5760));
await conn.ready();
const texts: string[] = [];
conn.on("STATUSTEXT", (m) => texts.push(m.fields.text));
const pm = new ParamManager(conn);
await pm.download();
await conn.setMessageRate(36, 50);

// make sure scripting is running
await conn.command(42701, [3]).catch(() => {});
await conn.waitFor("NAMED_VALUE_FLOAT", (m) => m.fields.name === "HSK", 15000);

const pwms = [...Array(16).keys()].map((i) => pm.params.get(`HSK_FS_PWM${i + 1}`)!.value);
const gate = pm.params.get("HSK_GATE")!.value;
const servo1 = () => conn.waitFor("SERVO_OUTPUT_RAW").then((m) => m.fields.servo1_raw);

// ---- A: latency with HSK_FS_DLY = 0 ----
for (const dly of [0, 1000]) {
  await pm.set("HSK_FS_DLY", dly);
  await pm.set("HSK_CFG_HASH", configHash(dly, gate, pwms));
  await sleep(1500);
  // time from the moment the vehicle acknowledges SIM_RC_FAIL=1 (echo) to the pose
  const r = await pm.set("SIM_RC_FAIL", 1);
  const t0 = performance.now();
  while ((await servo1()) !== pwms[0] && performance.now() - t0 < 6000) { /* wait */ }
  console.log(`A  HSK_FS_DLY=${dly}: pose ${Math.round(performance.now() - t0)} ms after RC cut acknowledged (RC_FS_TIMEOUT=${pm.params.get("RC_FS_TIMEOUT")?.value}); set ok=${r.ok}`);
  await pm.set("SIM_RC_FAIL", 0);
  await sleep(1500);
}

// ---- B: script dies while gate is passing ----
await pm.set("HSK_FS_DLY", 1000);
await pm.set("HSK_CFG_HASH", configHash(1000, gate, pwms));
await sleep(1500);
let ack = await conn.command(400, [1]);
console.log(`B  gate passing, script running: arm result ${ack} (0 = armed)`);
if (ack === 0) { await conn.command(400, [0]); await sleep(500); }

await conn.command(42701, [2]); // stop scripting
await sleep(3000);
const n0 = texts.length;
ack = await conn.command(400, [1]);
await sleep(300);
console.log(`B  script STOPPED after passing: arm result ${ack} (0 = armed!) msgs: ${texts.slice(n0).join(" | ")}`);
if (ack === 0) await conn.command(400, [0]);

await conn.command(42701, [3]).catch(() => {});
await conn.close();
