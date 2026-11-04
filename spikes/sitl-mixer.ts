/**
 * SITL: husky.lua scripted mixer vs the TypeScript mixer.
 *   S5 = spoileron (roll -1, spoiler(RC7, unipolar) +0.5), S6 = upper spoiler on roll (+1, positive only)
 * S5 runs native Aileron underneath (fallback, script flips sign: OUT=-5); S6 runs SERVOn_TRIM (135).
 * Drives RC1 (roll) and RC7 (spoiler) with RC override in MANUAL, compares SERVO_OUTPUT_RAW with
 * evalMix() + the SERVOn mapping, then stops scripting and checks the outputs go to trim.
 *
 *   npx tsx spikes/sitl-mixer.ts [port=5762]
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MavConnection, ParamManager } from "../packages/vehicle/src/index.ts";
import { tcpTransport } from "../packages/vehicle/src/tcpTransport.ts";
import { encodeTerm, evalMix, spoilerInput, type MixTerm } from "../packages/profile/src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: [string, boolean, string][] = [];
const record = (c: string, p: boolean, d = "") => { results.push([c, p, d]); console.log(`${p ? "PASS" : "FAIL"}  ${c}  ${d}`); };

const lua = fileURLToPath(new URL("../scripts/husky.lua", import.meta.url)).replace(/\\/g, "/");
const wslPath = execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "wslpath", "-a", lua]).toString().trim();
execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lc", `cp '${wslPath}' ~/husky-sitl/scripts/husky.lua`]);

const conn = new MavConnection(await tcpTransport("127.0.0.1", Number(process.argv[2] ?? 5762)));
await conn.ready(8000);
conn.on("STATUSTEXT", (m) => { if (/HSK/.test(m.fields.text)) console.log(`      [vehicle] ${m.fields.text}`); });
await conn.command(42701, [3]).catch(() => {}); // restart scripting with the new script
await conn.waitFor("NAMED_VALUE_FLOAT", (m) => m.fields.name === "HSK" && m.fields.value >= 200, 15000);
const pm = new ParamManager(conn);
await pm.download();
await conn.setMessageRate(36, 25);
record("husky.lua v2 running with mixer params", pm.params.has("HSK_M4_T3"), `HSK_MIX_N=${pm.params.get("HSK_MIX_N")?.value}`);

const prof = { inputs: [spoilerInput(7)] };
const M1: MixTerm[] = [{ in: "roll", w: -1 }, { in: "spoiler", w: 0.5 }];
const M2: MixTerm[] = [{ in: "roll", w: 1, curve: "positive" }];
const setAll = async (v: Record<string, number>) => {
  for (const [k, x] of Object.entries(v)) { const r = await pm.set(k, x); if (!r.ok) throw new Error(`set ${k}: ${JSON.stringify(r)}`); }
};
await setAll({
  SERVO5_FUNCTION: 4, SERVO6_FUNCTION: 135,
  SERVO5_MIN: 1100, SERVO5_TRIM: 1500, SERVO5_MAX: 1900, SERVO5_REVERSED: 0,
  SERVO6_MIN: 1000, SERVO6_TRIM: 1400, SERVO6_MAX: 2000, SERVO6_REVERSED: 1,
  HSK_M1_OUT: -5, HSK_M1_T1: encodeTerm(M1[0]!, prof), HSK_M1_T2: encodeTerm(M1[1]!, prof), HSK_M1_T3: 0,
  HSK_M2_OUT: 6, HSK_M2_T1: encodeTerm(M2[0]!, prof), HSK_M2_T2: 0, HSK_M2_T3: 0,
  HSK_MIX_N: 2,
});
await conn.command(176, [1, 0]); // MAV_CMD_DO_SET_MODE custom MANUAL

const rc = (ch: number, s: string) => pm.params.get(`RC${ch}_${s}`)!.value;
const norm = (ch: number, pwm: number) => { // RC_Channel::norm_input (bipolar, around trim)
  const t = rc(ch, "TRIM"), r = rc(ch, "REVERSED") ? -1 : 1;
  const v = pwm < t ? (pwm - t) / (t - rc(ch, "MIN")) : (pwm - t) / (rc(ch, "MAX") - t);
  return Math.max(-1, Math.min(1, v)) * r;
};
const uni = (ch: number, pwm: number) => Math.max(0, Math.min(1, (pwm - rc(ch, "MIN")) / (rc(ch, "MAX") - rc(ch, "MIN"))));
const toPwm = (v: number, min: number, trim: number, max: number, rev: boolean) => {
  v = Math.max(-1, Math.min(1, rev ? -v : v));
  return Math.round(v >= 0 ? trim + v * (max - trim) : trim + v * (trim - min));
};

let stop = false;
let override = { roll: 1500, spoiler: 1100 };
const pump = (async () => {
  while (!stop) {
    await conn.send("RC_CHANNELS_OVERRIDE", {
      target_system: conn.target.sysid, target_component: conn.target.compid,
      chan1_raw: override.roll, chan2_raw: 1500, chan3_raw: rc(3, "MIN"), chan4_raw: 1500, chan7_raw: override.spoiler,
    });
    await sleep(50);
  }
})();
const servos = async () => {
  await conn.waitFor("SERVO_OUTPUT_RAW");
  const m = await conn.waitFor("SERVO_OUTPUT_RAW");
  return { s5: m.fields.servo5_raw, s6: m.fields.servo6_raw };
};

let worst = 0;
for (const roll of [1000, 1250, 1500, 1750, 2000]) {
  for (const spoiler of [1100, 1500, 1900]) {
    override = { roll, spoiler };
    await sleep(400);
    const got = await servos();
    // In MANUAL with no expo, ArduPilot's aileron output is the roll stick past its deadzone.
    const dz = rc(1, "DZ");
    const rollIn = Math.abs(roll - rc(1, "TRIM")) <= dz ? 0 : norm(1, roll);
    const inputs = { roll: rollIn, spoiler: uni(7, spoiler) };
    const want5 = toPwm(-evalMix(M1, inputs), 1100, 1500, 1900, false);
    const want6 = toPwm(evalMix(M2, inputs), 1000, 1400, 2000, true);
    const err = Math.max(Math.abs(got.s5 - want5), Math.abs(got.s6 - want6));
    worst = Math.max(worst, err);
    console.log(`  roll ${roll} spoiler ${spoiler}: S5 ${got.s5} (want ${want5})  S6 ${got.s6} (want ${want6})`);
  }
}
record("Lua mixer matches the TypeScript mixer", worst <= 12, `worst difference ${worst} µs (deadzone/rounding tolerance 12)`);

// Orphan behavior: stop scripting while the spoileron is deflected.
override = { roll: 2000, spoiler: 1900 };
await sleep(400);
const before = await servos();
await conn.command(42701, [2]);
await sleep(600);
const after = await servos();
// full right roll on a plain unreversed aileron = SERVO5_MAX
record("script stopped: spoileron falls back to a plain aileron", after.s5 === 1900,
  `S5 ${before.s5}→${after.s5} (plain aileron at full right roll = 1900)`);
record("script stopped: one-sided spoiler falls back to center", after.s6 === 1400, `S6 ${before.s6}→${after.s6} (trim 1400)`);

stop = true;
await pump;
await conn.send("RC_CHANNELS_OVERRIDE", { target_system: conn.target.sysid, target_component: conn.target.compid });
await conn.command(42701, [3]).catch(() => {});
await conn.waitFor("NAMED_VALUE_FLOAT", (m) => m.fields.name === "HSK", 15000);
await setAll({ HSK_MIX_N: 0, SERVO5_FUNCTION: 0, SERVO6_FUNCTION: 0 });
await conn.close();
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
