/**
 * Verification ledger. A physical check ("the right aileron goes up when I roll right") is only
 * valid for the exact parameters it was done with. Each check records a hash of the board's
 * values for the parameters it depends on; if any of them change, the check goes stale.
 */
import type { Profile } from "./types.ts";
import { mixInputs, rcOf } from "./mixer.ts";

export type CheckStatus = "ok" | "stale" | "todo";

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function hashParams(names: string[], board: ReadonlyMap<string, number>): string {
  return fnv1a([...new Set(names)].sort().map((n) => `${n}=${board.get(n) ?? "-"}`).join(";"));
}

const STICKS = (p: Profile) => {
  const chans = [p.rc.roll, p.rc.pitch, p.rc.throttle, p.rc.yaw];
  return ["RCMAP_ROLL", "RCMAP_PITCH", "RCMAP_THROTTLE", "RCMAP_YAW", ...chans.map((c) => `RC${c}_REVERSED`)];
};
const SCRIPT_MIX = Array.from({ length: 4 }, (_, k) => [`HSK_M${k + 1}_OUT`, `HSK_M${k + 1}_T1`, `HSK_M${k + 1}_T2`, `HSK_M${k + 1}_T3`]).flat();

/** Parameter names each check depends on. */
export function checkDeps(check: string, p: Profile): string[] {
  const servo = (n: number) => [`SERVO${n}_FUNCTION`, `SERVO${n}_REVERSED`];
  const allServos = p.surfaces.filter((s) => s.output).flatMap((s) => [...servo(s.output!), `SERVO${s.output}_MIN`, `SERVO${s.output}_MAX`, `SERVO${s.output}_TRIM`]);
  if (check === "sticks") return STICKS(p);
  if (check.startsWith("direction:")) {
    const s = p.surfaces.find((x) => x.id === check.slice(10));
    if (!s?.output) return [];
    const rcs = mixInputs(s).map((i) => rcOf(i, p)).filter((x): x is number => !!x).map((c) => `RC${c}_REVERSED`);
    return [...STICKS(p), ...servo(s.output), ...rcs, ...SCRIPT_MIX, "MIXING_GAIN", "MIXING_OFFSET"];
  }
  if (check === "stabilize") return [...STICKS(p), ...allServos, "AHRS_ORIENTATION", ...SCRIPT_MIX];
  // the tilt check proves the mounting; a re-level is only valid for the orientation it was done in
  if (check === "orientation") return ["AHRS_ORIENTATION"];
  if (check === "level") return ["AHRS_ORIENTATION", "AHRS_TRIM_X", "AHRS_TRIM_Y"];
  if (check === "accelcal") return ["INS_ACCOFFS_X", "INS_ACCOFFS_Y", "INS_ACCOFFS_Z", "INS_ACCSCAL_X", "INS_ACCSCAL_Y", "INS_ACCSCAL_Z"];
  if (check === "failsafe") {
    return [...allServos, "RC_FS_TIMEOUT", "HSK_ENABLE", "HSK_FS_DLY",
      ...Array.from({ length: 16 }, (_, i) => `HSK_FS_PWM${i + 1}`), ...p.motors.filter((m) => m.output).map((m) => `SERVO${m.output}_FUNCTION`)];
  }
  return [];
}

export function checkStatus(check: string, p: Profile, board: ReadonlyMap<string, number>): CheckStatus {
  const v = p.verifications[check];
  if (!v) return "todo";
  return v.hash === hashParams(checkDeps(check, p), board) ? "ok" : "stale";
}

/** Record a passed check against the board's current values. Returns a new profile. */
export function recordCheck(check: string, p: Profile, board: ReadonlyMap<string, number>): Profile {
  return { ...p, verifications: { ...p.verifications, [check]: { hash: hashParams(checkDeps(check, p), board), at: new Date().toISOString() } } };
}

export function clearCheck(check: string, p: Profile): Profile {
  const v = { ...p.verifications };
  delete v[check];
  return { ...p, verifications: v };
}
