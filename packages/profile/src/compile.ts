/**
 * Profile → parameters. Pure and deterministic: same profile + same board facts = same output.
 * Every parameter is tagged with the wizard step that owns it, so each step can apply just its
 * own part and the final review can apply everything.
 */
import { configHash } from "./failsafe.ts";
import { FN, encodeTerm, fallbackFunction, nativeFunction, type NativeMatch } from "./mixer.ts";
import type { MotorProtocol, Profile, Surface } from "./types.ts";
import { PERIPHERALS, profilePorts } from "./peripherals.ts";

export type StepId =
  | "receiver" | "sticks" | "modes" | "outputs" | "motor" | "directions" | "trims"
  | "failsafe" | "arming" | "orientation" | "pinned";

export interface BoardFacts {
  /** current value of every parameter on the board (names absent = not on this firmware/config) */
  params: ReadonlyMap<string, number>;
  /** firmware has Lua scripting (SCR_ENABLE exists) */
  hasScripting: boolean;
  /** number of servo outputs to manage */
  outputs: number;
}

/** fn = the native fallback the output runs if the script stops; invert = script output sign */
export interface ScriptedSurface { surfaceId: string; output: number; slot: number; fn: number; invert: boolean; fallback: string }

export interface Compiled {
  params: Record<string, number>;
  owner: Record<string, StepId>;
  /** native function chosen for each surface (or undefined = scripted) */
  native: Record<string, NativeMatch | undefined>;
  scripted: ScriptedSurface[];
  /** compiled params this board doesn't have (yet): script params before install, DShot on SITL… */
  absent: string[];
  notes: string[];
}

export const MAX_SCRIPTED = 4;
export const HSK_GATE_DEFAULT = 7;

const OTYPE: Record<MotorProtocol, number> = { PWM: 0, DSHOT150: 4, DSHOT300: 5, DSHOT600: 6, DSHOT1200: 7 };
/** Plane mode number → FLTMODE_GCSBLOCK bit (from the 4.7 parameter docs). */
const GCSBLOCK_BIT: Record<number, number> = {
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 10: 9, 12: 10, 13: 11, 14: 12, 15: 13,
  24: 14, 17: 15, 18: 16, 19: 17, 23: 18, 22: 19, 25: 20, 26: 21,
};
/** ARMING_SKIPCHK bits on 4.7 (bit 17 = AuxAuth is the one we keep). */
const SKIPCHK_BITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19];
const AUXAUTH_BIT = 17;

export function compile(profile: Profile, board: BoardFacts, allowedModes: number[] = [0, 4, 5]): Compiled {
  const params: Record<string, number> = {};
  const owner: Record<string, StepId> = {};
  const notes: string[] = [];
  const set = (step: StepId, name: string, value: number) => { params[name] = value; owner[name] = step; };
  const cur = (n: string) => board.params.get(n);
  const scripting = board.hasScripting && profile.failsafe.mode === "pose";

  // ---- peripherals (serial ports) ----
  const ports = profilePorts(profile);
  for (const [n, kind] of Object.entries(ports)) {
    if (kind === "keep" || !board.params.has(`SERIAL${n}_PROTOCOL`)) continue;
    const info = PERIPHERALS[kind];
    set("receiver", `SERIAL${n}_PROTOCOL`, info.protocol);
    const baud = profile.portBaud?.[n] ?? info.baud;
    if (baud !== undefined && kind !== "rc" && kind !== "rc-elrs") set("receiver", `SERIAL${n}_BAUD`, baud);
  }
  const kinds = Object.values(ports);
  const rcOpt = cur("RC_OPTIONS") ?? 0;
  if (kinds.includes("rc-mavlink")) set("receiver", "RSSI_TYPE", 5);
  else if (kinds.includes("rc-elrs")) {
    set("receiver", "RSSI_TYPE", 3);
    set("receiver", "RC_OPTIONS", (rcOpt | (1 << 13)) >>> 0); // ELRS runs CRSF at 420k
  } else if (kinds.includes("rc") && (rcOpt >> 13) & 1) {
    set("receiver", "RC_OPTIONS", (rcOpt & ~(1 << 13)) >>> 0); // not ELRS: standard CRSF 416k
  }

  // ---- sticks ----
  const rc = profile.rc;
  set("sticks", "RCMAP_ROLL", rc.roll);
  set("sticks", "RCMAP_PITCH", rc.pitch);
  set("sticks", "RCMAP_THROTTLE", rc.throttle);
  set("sticks", "RCMAP_YAW", rc.yaw);
  for (const [ch, rev] of Object.entries(rc.reversed)) set("sticks", `RC${ch}_REVERSED`, rev ? 1 : 0);
  for (const [ch, r] of Object.entries(rc.ranges)) {
    set("sticks", `RC${ch}_MIN`, r.min);
    set("sticks", `RC${ch}_MAX`, r.max);
    set("sticks", `RC${ch}_TRIM`, r.trim);
  }
  if (profile.flapChannel) set("sticks", `RC${profile.flapChannel}_OPTION`, 208);

  // ---- modes ----
  set("modes", "FLTMODE_CH", profile.modes.channel);
  profile.modes.slots.forEach((m, i) => set("modes", `FLTMODE${i + 1}`, m));
  set("modes", "INITIAL_MODE", 0);
  if (cur("FLTMODE_GCSBLOCK") !== undefined) {
    let mask = 0;
    for (const [mode, bit] of Object.entries(GCSBLOCK_BIT)) if (!allowedModes.includes(Number(mode))) mask += 2 ** bit;
    set("modes", "FLTMODE_GCSBLOCK", mask);
  }

  // ---- outputs: surfaces, motors, everything else disabled ----
  const used = new Set<number>();
  const native: Record<string, NativeMatch | undefined> = {};
  const scripted: ScriptedSurface[] = [];
  for (const s of profile.surfaces) {
    const m = nativeFunction(s, profile);
    native[s.id] = m;
    if (!s.output) continue;
    used.add(s.output);
    const p = `SERVO${s.output}_`;
    if (m) {
      set("outputs", `${p}FUNCTION`, m.fn);
    } else {
      const fb = fallbackFunction(s, profile);
      scripted.push({ surfaceId: s.id, output: s.output, slot: scripted.length + 1, fn: fb.fn, invert: fb.invert, fallback: fb.label });
      set("outputs", `${p}FUNCTION`, fb.fn);
    }
    // Endpoints, center and reversal belong to the surface, so they follow it to whichever pad it's on.
    set("directions", `${p}REVERSED`, s.reversed ? 1 : 0);
    applyTrims(s, p, set);
  }
  for (const mo of profile.motors) {
    if (!mo.output) continue;
    used.add(mo.output);
    set("outputs", `SERVO${mo.output}_FUNCTION`,
      mo.position === "left" ? FN.THROTTLE_LEFT : mo.position === "right" ? FN.THROTTLE_RIGHT : FN.THROTTLE);
  }
  for (let n = 1; n <= board.outputs; n++) {
    if (!used.has(n) && cur(`SERVO${n}_FUNCTION`) !== undefined) set("outputs", `SERVO${n}_FUNCTION`, FN.DISABLED);
  }

  // ---- motor / ESC ----
  const dshot = profile.motors.filter((m) => m.output && m.protocol !== "PWM");
  const mask = dshot.reduce((a, m) => a | (1 << (m.output! - 1)), 0);
  set("motor", "SERVO_BLH_MASK", mask);
  set("motor", "SERVO_BLH_OTYPE", dshot.length ? OTYPE[dshot[0]!.protocol] : 0);
  set("motor", "SERVO_BLH_BDMASK", dshot.filter((m) => m.bidir).reduce((a, m) => a | (1 << (m.output! - 1)), 0));
  if (dshot.length) set("motor", "SERVO_BLH_POLES", dshot[0]!.poles);
  if (new Set(dshot.map((m) => m.protocol)).size > 1) notes.push("All DShot motors share one protocol; using the first motor's.");
  // (an ESC telemetry wire is a peripheral: see ports)

  // ---- failsafe ----
  const delay = Math.max(500, profile.failsafe.delayMs);
  const rcTimeout = Math.min(delay, 10000) / 1000;
  set("failsafe", "THR_FAILSAFE", 1);
  set("failsafe", "FS_SHORT_ACTN", 2);
  set("failsafe", "FS_LONG_ACTN", 2);
  set("failsafe", "RC_FS_TIMEOUT", rcTimeout);
  set("failsafe", "FS_GCS_ENABL", 0);
  if (cur("AFS_ENABLE") !== undefined) set("failsafe", "AFS_ENABLE", 0);
  if (scripting) {
    set("failsafe", "SCR_ENABLE", 1);
    set("failsafe", "HSK_ENABLE", 1);
    const fsDly = Math.max(0, delay - rcTimeout * 1000);
    const pwms = Array.from({ length: 16 }, (_, i) => profile.failsafe.capturedPwm?.[i] ?? 0);
    set("failsafe", "HSK_FS_DLY", fsDly);
    pwms.forEach((v, i) => set("failsafe", `HSK_FS_PWM${i + 1}`, v));
    set("failsafe", "HSK_GATE", HSK_GATE_DEFAULT);
    set("failsafe", "HSK_CFG_HASH", configHash(fsDly, HSK_GATE_DEFAULT, pwms));
  }
  // scripted mixer (needs scripting even in "glide" mode)
  if (scripted.length) {
    if (!board.hasScripting) notes.push("Scripted surfaces need Lua scripting, which this board's firmware doesn't have.");
    set("outputs", "SCR_ENABLE", 1);
    set("outputs", "HSK_MIX_N", Math.min(scripted.length, MAX_SCRIPTED));
    for (let k = 1; k <= MAX_SCRIPTED; k++) {
      const sc = scripted[k - 1];
      const s = sc ? profile.surfaces.find((x) => x.id === sc.surfaceId)! : undefined;
      // negative = the script flips its output so it agrees with the fallback function's sign
      set("outputs", `HSK_M${k}_OUT`, sc ? (sc.invert ? -sc.output : sc.output) : 0);
      for (let t = 1; t <= 3; t++) {
        const term = s?.mix.filter((x) => x.w !== 0)[t - 1];
        set("outputs", `HSK_M${k}_T${t}`, term ? encodeTerm(term, profile) : 0);
      }
    }
  } else if (board.params.has("HSK_MIX_N")) {
    set("outputs", "HSK_MIX_N", 0);
  }

  // ---- board orientation ----
  if (profile.orientation !== undefined) set("orientation", "AHRS_ORIENTATION", profile.orientation);

  // ---- arming ----
  set("arming", "ARMING_REQUIRE", 1);
  const a = profile.arming;
  if (a.method === "rudder-script" && board.hasScripting) {
    set("arming", "ARMING_RUDDER", 0);
    set("arming", "HSK_RUD_ARM", 1);
    set("arming", "HSK_RUD_MS", 2000);
  } else {
    if (a.method === "rudder-script") notes.push("No scripting on this board: using ArduPilot's own rudder arming.");
    set("arming", "ARMING_RUDDER", a.method === "switch" ? 0 : a.rudderDisarm ? 2 : 1);
    if (board.params.has("HSK_RUD_ARM")) set("arming", "HSK_RUD_ARM", 0);
    if (a.method === "switch" && a.switchChannel) set("arming", `RC${a.switchChannel}_OPTION`, 153);
  }
  // arming checks: skip all but the script's aux-auth gate (all, if there's no script)
  const gate = board.hasScripting && (scripting || a.method === "rudder-script");
  if (cur("ARMING_SKIPCHK") !== undefined) {
    set("arming", "ARMING_SKIPCHK", gate ? SKIPCHK_BITS.reduce((s, b) => s + 2 ** b, 0) : -1);
  } else if (cur("ARMING_CHECK") !== undefined) {
    set("arming", "ARMING_CHECK", gate ? 2 ** AUXAUTH_BIT : 0); // pre-4.7: bitmask of checks to RUN
  }

  // ---- pinned raw params last: the team's explicit word wins ----
  for (const [k, v] of Object.entries(profile.pinned)) set("pinned", k, v);

  const absent = Object.keys(params).filter((k) => !board.params.has(k));
  return { params, owner, native, scripted, absent, notes };
}

export const DEFAULT_ENDPOINTS = { min: 1100, trim: 1500, max: 1900 };

function applyTrims(s: Surface, p: string, set: (step: StepId, name: string, value: number) => void) {
  set("trims", `${p}MIN`, s.min ?? DEFAULT_ENDPOINTS.min);
  set("trims", `${p}TRIM`, s.trim ?? DEFAULT_ENDPOINTS.trim);
  set("trims", `${p}MAX`, s.max ?? DEFAULT_ENDPOINTS.max);
}

/** Parameters whose compiled value differs from the board (and exist on the board). */
export function diffCompiled(c: Compiled, board: ReadonlyMap<string, number>, steps?: StepId[]) {
  return Object.entries(c.params)
    .filter(([k]) => !steps || steps.includes(c.owner[k]!))
    .filter(([k, v]) => board.has(k) && Math.fround(board.get(k)!) !== Math.fround(v))
    .map(([name, value]) => ({ name, value, from: board.get(name)!, step: c.owner[name]! }));
}
