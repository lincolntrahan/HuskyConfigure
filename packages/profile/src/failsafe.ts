/**
 * Failsafe pose → per-output PWM, and the config hash shared with scripts/husky.lua.
 *
 * ArduPilot sign conventions (Plane): a positive scaled output means roll RIGHT (aileron),
 * nose UP (elevator), yaw RIGHT (rudder). Flaps are 0..100 % (down). An unreversed output maps
 * +full to SERVOn_MAX and -full to SERVOn_MIN; SERVOn_REVERSED swaps them. The physical
 * surface direction is made right by the direction checks, so the pose only needs the sign.
 *
 * Prototype scope: outputs with a single native function. Mixed surfaces go through the
 * general mixer (§5.9 of the architecture), which isn't written yet.
 */

export const FN = {
  FLAP: 2, FLAP_AUTO: 3, AILERON: 4, ELEVATOR: 19, RUDDER: 21, GROUND_STEERING: 26,
  THROTTLE: 70, THROTTLE_LEFT: 73, THROTTLE_RIGHT: 74,
} as const;

export interface OutputConfig {
  /** 1-based output number */
  n: number;
  fn: number;
  min: number;
  trim: number;
  max: number;
  reversed: boolean;
}

/** Normalized DBF pose per logical axis: +1 / -1 full, 0..1 for flaps, throttle 0 = closed. */
export const DBF_POSE = { roll: 1, pitch: 1, yaw: 1, flap: 1, throttle: 0 } as const;

function angle(o: OutputConfig, v: number): number {
  const s = o.reversed ? -v : v;
  return Math.round(s >= 0 ? o.trim + s * (o.max - o.trim) : o.trim + s * (o.trim - o.min));
}
function range(o: OutputConfig, v01: number): number {
  const s = o.reversed ? 1 - v01 : v01;
  return Math.round(o.min + s * (o.max - o.min));
}

/** PWM the failsafe pose puts on this output, or 0 for "leave it alone". */
export function posePwm(o: OutputConfig, pose = DBF_POSE): number {
  switch (o.fn) {
    case FN.AILERON: return angle(o, pose.roll);
    case FN.ELEVATOR: return angle(o, pose.pitch);
    case FN.RUDDER:
    case FN.GROUND_STEERING: return angle(o, pose.yaw);
    case FN.FLAP:
    case FN.FLAP_AUTO: return range(o, pose.flap);
    case FN.THROTTLE:
    case FN.THROTTLE_LEFT:
    case FN.THROTTLE_RIGHT: return range(o, pose.throttle);
    default: return 0;
  }
}

/** Must match config_hash() in scripts/husky.lua. */
export const HASH_MOD = 16777213;
export function configHash(fsDelayMs: number, gate: number, pwms: readonly number[]): number {
  let h = (fsDelayMs * 7 + gate * 13) % HASH_MOD;
  for (let n = 1; n <= 16; n++) h = (h + Math.floor(pwms[n - 1] ?? 0) * (n * 31 + 17)) % HASH_MOD;
  return Math.floor(h);
}
