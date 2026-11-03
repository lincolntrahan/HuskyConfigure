/**
 * Phase 0 spike: husky.lua in SITL.
 *   1. enable scripting, install scripts/husky.lua, reboot
 *   2. write the failsafe pose (computed in TS) + arming-gate config
 *   3. gate: blocked / tampered config refuse to arm; good config arms
 *   4. failsafe: SIM_RC_FAIL=1 → pose after ~1 s; RC back → released
 *   5. script stopped during failsafe → outputs released to native GLIDE; arming refused
 *
 *   npx tsx spikes/sitl-failsafe.ts
 * Requires SITL on 127.0.0.1:5760 running in ~/husky-sitl (WSL).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MavConnection, ParamManager } from "../packages/vehicle/src/index.ts";
import { tcpTransport } from "../packages/vehicle/src/tcpTransport.ts";
import { configHash, posePwm, type OutputConfig } from "../packages/profile/src/index.ts";

const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail = "") => {
  results.push({ check, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(expectScript = false): Promise<{ conn: MavConnection; pm: ParamManager; texts: string[] }> {
  for (let i = 0; i < 40; i++) {
    try {
      const conn = new MavConnection(await tcpTransport("127.0.0.1", 5760, 2000));
      await conn.ready(5000);
      const texts: string[] = [];
      conn.on("STATUSTEXT", (m) => { texts.push(m.fields.text); if (m.fields.text.startsWith("HSK")) console.log(`      [vehicle] ${m.fields.text}`); });
      // Scripts start a few seconds after boot and add their params then; wait for the heartbeat.
      if (expectScript) await conn.waitFor("NAMED_VALUE_FLOAT", (m) => m.fields.name === "HSK", 15000);
      const pm = new ParamManager(conn);
      await pm.download();
      await conn.setMessageRate(36, 25); // SERVO_OUTPUT_RAW
      await conn.setMessageRate(65, 10); // RC_CHANNELS
      return { conn, pm, texts };
    } catch { await sleep(500); }
  }
  throw new Error("could not connect to SITL");
}

async function reboot(conn: MavConnection) {
  await conn.command(246, [1]).catch(() => {});
  await conn.close();
  await sleep(2000);
}

async function setAll(pm: ParamManager, values: Record<string, number>) {
  for (const [k, v] of Object.entries(values)) {
    const r = await pm.set(k, v);
    if (!r.ok) throw new Error(`could not set ${k}=${v}: ${JSON.stringify(r)}`);
  }
}

const servoNow = (conn: MavConnection) => conn.waitFor("SERVO_OUTPUT_RAW", () => true, 2000)
  .then((m) => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => (m.fields as unknown as Record<string, number>)[`servo${i}_raw`]!));

async function waitServos(conn: MavConnection, pred: (s: number[]) => boolean, timeoutMs: number): Promise<number | undefined> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (pred(await servoNow(conn))) return performance.now() - t0;
  }
  return undefined;
}

async function tryArm(conn: MavConnection, texts: string[]): Promise<{ result: number; msgs: string[] }> {
  const start = texts.length;
  const result = await conn.command(400, [1]);
  await sleep(300);
  return { result, msgs: texts.slice(start) };
}

// ---- 1. install ----
let { conn, pm, texts } = await connect();
const ver = pm.params.get("SCR_ENABLE");
console.log(`connected; SCR_ENABLE=${ver?.value}`);
const lua = fileURLToPath(new URL("../scripts/husky.lua", import.meta.url));
const wslPath = execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "wslpath", "-a", lua.replace(/\\/g, "/")]).toString().trim();
execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lc", `mkdir -p ~/husky-sitl/scripts && cp '${wslPath}' ~/husky-sitl/scripts/husky.lua`]);
if (ver?.value !== 1) await setAll(pm, { SCR_ENABLE: 1 });
await reboot(conn);
({ conn, pm, texts } = await connect(true));
record("script loaded (HSK_ params exist)", pm.params.has("HSK_ENABLE"), `SCR_HEAP_SIZE=${pm.params.get("SCR_HEAP_SIZE")?.value}`);
if (!pm.params.has("HSK_ENABLE")) process.exit(1);

// ---- 2. configure ----
const outputs: OutputConfig[] = [];
for (let n = 1; n <= 16; n++) {
  const g = (s: string) => pm.params.get(`SERVO${n}_${s}`)!.value;
  outputs.push({ n, fn: g("FUNCTION"), min: g("MIN"), trim: g("TRIM"), max: g("MAX"), reversed: g("REVERSED") === 1 });
}
const pwms = outputs.map((o) => posePwm(o));
console.log("pose:", outputs.filter((o) => pwms[o.n - 1]).map((o) => `S${o.n}(fn ${o.fn})=${pwms[o.n - 1]}`).join(" "));
const FS_DLY = 0, GATE = 7; // total delay comes from RC_FS_TIMEOUT (1 s)
const skipAllButAuxAuth = [...Array(20).keys()].filter((b) => b >= 1 && b !== 17).reduce((s, b) => s + 2 ** b, 0);
const gcsBlockAllButManualFbwaAcro = (2 ** 22 - 1) - (2 ** 0 + 2 ** 4 + 2 ** 5);
await setAll(pm, {
  THR_FAILSAFE: 1, FS_SHORT_ACTN: 2, FS_LONG_ACTN: 2, RC_FS_TIMEOUT: 1, ARMING_RUDDER: 0,
  ARMING_SKIPCHK: skipAllButAuxAuth, FLTMODE_GCSBLOCK: gcsBlockAllButManualFbwaAcro,
  HSK_FS_DLY: FS_DLY, HSK_GATE: GATE, HSK_BLOCK: 0,
  ...Object.fromEntries(pwms.map((p, i) => [`HSK_FS_PWM${i + 1}`, p])),
  HSK_CFG_HASH: configHash(FS_DLY, GATE, pwms),
});
const pose = pwms.slice(0, 8);
const isPose = (s: number[]) => s.every((v, i) => !pose[i] || Math.abs(v - pose[i]!) <= 1);
await sleep(500);

// ---- 3. arming gate ----
await setAll(pm, { HSK_BLOCK: 1 });
let a = await tryArm(conn, texts);
record("gate: HSK_BLOCK=1 refuses arming", a.result !== 0, `result ${a.result}; ${a.msgs.filter((t) => /HSK|Arm|arm/.test(t)).join(" | ")}`);
await setAll(pm, { HSK_BLOCK: 0 });

await setAll(pm, { HSK_FS_PWM1: pwms[0]! + 10 });
await sleep(300);
a = await tryArm(conn, texts);
record("gate: hand-edited config refuses arming", a.result !== 0, `result ${a.result}; ${a.msgs.filter((t) => /HSK/.test(t)).join(" | ")}`);
await setAll(pm, { HSK_FS_PWM1: pwms[0]! });
await sleep(300);

a = await tryArm(conn, texts);
record("gate: good config arms", a.result === 0 && conn.armed !== undefined, `result ${a.result}; ${a.msgs.join(" | ")}`);
if (a.result === 0) { await conn.command(400, [0]); await sleep(500); }

// ---- 4. failsafe ----
const normal = await servoNow(conn);
console.log("normal outputs:", normal.join(" "));
await setAll(pm, { SIM_RC_FAIL: 1 });
const tLost = performance.now();
const tPose = await waitServos(conn, isPose, 5000);
record("failsafe: pose reached after RC loss", tPose !== undefined,
  tPose !== undefined ? `${Math.round(performance.now() - tLost - 0)} ms after RC cut (RC_FS_TIMEOUT 1 s + HSK_FS_DLY ${FS_DLY} ms)` : "never");
const during = await servoNow(conn);
console.log("failsafe outputs:", during.join(" "), "mode", conn.lastHeartbeat?.fields.custom_mode);
// heartbeats are 1 Hz, so give the mode change up to 2.5 s to show up
const glide = await conn.waitFor("HEARTBEAT", (m) => m.compid === 1 && m.fields.custom_mode === 5, 2500).then(() => true, () => false);
record("failsafe: native layer went to GLIDE (FBWA=5)", glide, `custom_mode ${conn.lastHeartbeat?.fields.custom_mode}`);

await setAll(pm, { SIM_RC_FAIL: 0 });
const tBack = await waitServos(conn, (s) => !isPose(s), 3000);
record("failsafe: released when RC returns", tBack !== undefined, tBack !== undefined ? `${Math.round(tBack)} ms` : "stuck in pose");

// ---- 5. script stops during failsafe ----
await setAll(pm, { SIM_RC_FAIL: 1 });
await waitServos(conn, isPose, 5000);
await conn.command(42701, [2]).catch((e) => console.log("scripting stop:", e.message)); // SCRIPTING_CMD_STOP
const tRel = await waitServos(conn, (s) => !isPose(s), 3000);
const after = await servoNow(conn);
record("script stopped: pose released (native failsafe takes over)", tRel !== undefined,
  `${tRel !== undefined ? Math.round(tRel) + " ms" : "held!"}; outputs ${after.join(" ")}`);
await setAll(pm, { SIM_RC_FAIL: 0 });
await sleep(1500);
a = await tryArm(conn, texts);
record("script stopped: arming refused", a.result !== 0, `result ${a.result}; ${a.msgs.join(" | ")}`);
if (a.result === 0) await conn.command(400, [0]);
await conn.command(42701, [3]).catch(() => {}); // restart scripting

await conn.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
