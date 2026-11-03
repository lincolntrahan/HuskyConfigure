/**
 * Phase 0 spike: script-owned rudder arming.
 *   1. install the updated husky.lua, restart scripting
 *   2. ARMING_RUDDER=0 (native rudder arming off)
 *   3. hold right rudder + low throttle via RC override: script running → arms
 *   4. stop scripting, hold again → must NOT arm
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MavConnection, ParamManager } from "../packages/vehicle/src/index.ts";
import { tcpTransport } from "../packages/vehicle/src/tcpTransport.ts";
import { configHash } from "../packages/profile/src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: [string, boolean, string][] = [];
const record = (c: string, p: boolean, d = "") => { results.push([c, p, d]); console.log(`${p ? "PASS" : "FAIL"}  ${c}  ${d}`); };

const lua = fileURLToPath(new URL("../scripts/husky.lua", import.meta.url)).replace(/\\/g, "/");
const wslPath = execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "wslpath", "-a", lua]).toString().trim();
execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lc", `cp '${wslPath}' ~/husky-sitl/scripts/husky.lua`]);

let conn = new MavConnection(await tcpTransport("127.0.0.1", 5760));
await conn.ready();
// The param table layout changed, so reboot for a clean table, then reconnect.
await conn.command(246, [1]).catch(() => {});
await conn.close();
await sleep(2500);
for (let i = 0; ; i++) {
  try { conn = new MavConnection(await tcpTransport("127.0.0.1", 5760, 2000)); await conn.ready(5000); break; }
  catch { if (i > 30) throw new Error("no reconnect"); await sleep(500); }
}
const texts: string[] = [];
conn.on("STATUSTEXT", (m) => { texts.push(m.fields.text); if (/HSK|Arm|arm/.test(m.fields.text)) console.log(`      [vehicle] ${m.fields.text}`); });
await conn.waitFor("NAMED_VALUE_FLOAT", (m) => m.fields.name === "HSK", 15000);
const pm = new ParamManager(conn);
await pm.download();

// After a table-layout change the saved slots are meaningless: rewrite the pose from SERVOn_*.
const { posePwm } = await import("../packages/profile/src/index.ts");
const pwms = [...Array(16).keys()].map((i) => {
  const g = (s: string) => pm.params.get(`SERVO${i + 1}_${s}`)!.value;
  return posePwm({ n: i + 1, fn: g("FUNCTION"), min: g("MIN"), trim: g("TRIM"), max: g("MAX"), reversed: g("REVERSED") === 1 });
});
for (let i = 0; i < 16; i++) await pm.set(`HSK_FS_PWM${i + 1}`, pwms[i]!);
const rc = (ch: number, s: string) => pm.params.get(`RC${ch}_${s}`)!.value;
const YAW_RIGHT = rc(4, "MAX"), THR_LOW = rc(3, "MIN"), THR_MID = Math.round((rc(3, "MIN") + rc(3, "MAX")) / 2);
console.log(`RC4 ${rc(4, "MIN")}-${rc(4, "MAX")} rev ${rc(4, "REVERSED")}, RC3 ${rc(3, "MIN")}-${rc(3, "MAX")}`);
const gate = pm.params.get("HSK_GATE")!.value;
for (const [k, v] of Object.entries({ ARMING_RUDDER: 0, HSK_FS_DLY: 0, HSK_RUD_ARM: 1, HSK_RUD_MS: 2000 })) {
  const r = await pm.set(k, v); if (!r.ok) throw new Error(`set ${k} failed`);
}
await pm.set("HSK_CFG_HASH", configHash(0, gate, pwms));
console.log(`table: FS_PWM1..4 = ${pwms.slice(0, 4).join(",")}  RCMAP_YAW=${pm.params.get("RCMAP_YAW")?.value} RCMAP_THROTTLE=${pm.params.get("RCMAP_THROTTLE")?.value}`);
await sleep(1500);

/** Hold sticks with RC_CHANNELS_OVERRIDE at 20 Hz for ms; 0 releases a channel. */
async function holdSticks(ms: number, yaw: number, thr: number) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await conn.send("RC_CHANNELS_OVERRIDE", {
      target_system: conn.target.sysid, target_component: conn.target.compid,
      chan1_raw: 1500, chan2_raw: 1500, chan3_raw: thr, chan4_raw: yaw,
    });
    await sleep(50);
  }
}
const release = () => conn.send("RC_CHANNELS_OVERRIDE", { target_system: conn.target.sysid, target_component: conn.target.compid });

// short hold (< RUD_MS) must not arm
await holdSticks(1000, YAW_RIGHT, THR_LOW);
await holdSticks(500, 1500, THR_LOW);
record("short rudder hold (1 s) does not arm", !conn.armed);

await holdSticks(3000, YAW_RIGHT, THR_LOW);
await holdSticks(500, 1500, THR_LOW);
const armedByScript = conn.armed;
record("script running: 2 s right rudder + low throttle arms", armedByScript);
if (armedByScript) { await conn.command(400, [0]); await sleep(800); }

await holdSticks(3000, YAW_RIGHT, THR_MID);
await holdSticks(300, 1500, THR_LOW);
record("rudder with throttle up does not arm", !conn.armed);
if (conn.armed) { await conn.command(400, [0]); await sleep(800); }

await conn.command(42701, [2]); // stop scripting
await sleep(1500);
await holdSticks(4000, YAW_RIGHT, THR_LOW);
await holdSticks(500, 1500, THR_LOW);
record("script STOPPED: rudder hold does not arm", !conn.armed);
if (conn.armed) { await conn.command(400, [0]); await sleep(800); }

await release();
await conn.command(42701, [3]).catch(() => {});
await conn.close();
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
