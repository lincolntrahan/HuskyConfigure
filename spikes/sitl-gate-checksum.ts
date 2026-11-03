/**
 * Phase 0 spike: does ArduPilot's running-script checksum close the "script died while the
 * gate was passing" hole, and does that check survive ARMING_SKIPCHK?
 */
import { MavConnection, ParamManager } from "../packages/vehicle/src/index.ts";
import { tcpTransport } from "../packages/vehicle/src/tcpTransport.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conn = new MavConnection(await tcpTransport("127.0.0.1", 5760));
await conn.ready();
const texts: string[] = [];
conn.on("STATUSTEXT", (m) => texts.push(m.fields.text));
const pm = new ParamManager(conn);

async function restartScripts() {
  await conn.command(42701, [3]).catch(() => {});
  await conn.waitFor("NAMED_VALUE_FLOAT", (m) => m.fields.name === "HSK", 15000);
  await sleep(1500);
}
async function arm(label: string) {
  const n0 = texts.length;
  const r = await conn.command(400, [1]);
  await sleep(400);
  console.log(`${label}: arm result ${r}${r === 0 ? " (ARMED)" : ""}  ${texts.slice(n0).join(" | ")}`);
  if (r === 0) { await conn.command(400, [0]); await sleep(500); }
  return r;
}

await restartScripts();
await pm.download();
console.log("SCR_LD_CHECKSUM", pm.params.get("SCR_LD_CHECKSUM")?.value, "SCR_RUN_CHECKSUM", pm.params.get("SCR_RUN_CHECKSUM")?.value,
  "SCR_DEBUG_OPTS", pm.params.get("SCR_DEBUG_OPTS")?.value);

// Ask ArduPilot to record the checksums of the scripts loaded/running right now (SCR_DEBUG_OPTS bit 5).
await pm.set("SCR_DEBUG_OPTS", (pm.params.get("SCR_DEBUG_OPTS")!.value | 32));
await sleep(1500);
const ld = await pm.read("SCR_LD_CHECKSUM");
const run = await pm.read("SCR_RUN_CHECKSUM");
console.log("recorded: SCR_LD_CHECKSUM", ld.value, "SCR_RUN_CHECKSUM", run.value, "SCR_DEBUG_OPTS now", (await pm.read("SCR_DEBUG_OPTS")).value);

const skipNow = pm.params.get("ARMING_SKIPCHK")!.value;
await arm("checksums set, script running");

await conn.command(42701, [2]); // stop
await sleep(3000);
await arm("checksums set, script STOPPED, SKIPCHK all-but-auxauth");

await pm.set("ARMING_SKIPCHK", -1);
await sleep(1500);
await arm("checksums set, script STOPPED, SKIPCHK=-1 (skip everything)");
await pm.set("ARMING_SKIPCHK", skipNow);

await restartScripts();
await arm("script restarted");
await conn.close();
