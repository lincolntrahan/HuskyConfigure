/**
 * Build a profile from a board's current parameters ("start from what's on the board").
 * Compiling the result reproduces the board's output functions, so importing changes nothing
 * until the user edits something.
 */
import { FN } from "./mixer.ts";
import { normalizeSurface, withLayout } from "./describe.ts";
import { portsFromBoard } from "./peripherals.ts";
import { emptyProfile, type Motor, type MotorProtocol, type Profile, type Surface, type SurfaceKind, type MixTerm } from "./types.ts";

const OTYPE_TO: Record<number, MotorProtocol> = { 4: "DSHOT150", 5: "DSHOT300", 6: "DSHOT600", 7: "DSHOT1200" };

const NATIVE: Record<number, { kind: SurfaceKind; side?: Surface["side"]; mix: MixTerm[]; name: string }> = {
  [FN.AILERON]: { kind: "aileron", mix: [{ in: "roll", w: 1 }], name: "Aileron" },
  [FN.ELEVATOR]: { kind: "elevator", mix: [{ in: "pitch", w: 1 }], name: "Elevator" },
  [FN.RUDDER]: { kind: "rudder", mix: [{ in: "yaw", w: 1 }], name: "Rudder" },
  [FN.GROUND_STEERING]: { kind: "steering", mix: [{ in: "yaw", w: 1 }], name: "Steering" },
  [FN.FLAP]: { kind: "flap", mix: [{ in: "flap", w: -1 }], name: "Flap" },
  [FN.FLAP_AUTO]: { kind: "flap", mix: [{ in: "flap", w: -1 }], name: "Flap" },
  [FN.ELEVON_LEFT]: { kind: "elevon", side: "left", mix: [{ in: "pitch", w: 1 }, { in: "roll", w: -1 }], name: "Left elevon" },
  [FN.ELEVON_RIGHT]: { kind: "elevon", side: "right", mix: [{ in: "pitch", w: 1 }, { in: "roll", w: 1 }], name: "Right elevon" },
  [FN.VTAIL_LEFT]: { kind: "ruddervator", side: "left", mix: [{ in: "pitch", w: 1 }, { in: "yaw", w: 1 }], name: "Left ruddervator" },
  [FN.VTAIL_RIGHT]: { kind: "ruddervator", side: "right", mix: [{ in: "pitch", w: 1 }, { in: "yaw", w: -1 }], name: "Right ruddervator" },
  // intent: roll right lowers the left flaperon, flaps lower both (same sign pattern as ArduPilot's left)
  [FN.FLAPERON_LEFT]: { kind: "flaperon", side: "left", mix: [{ in: "roll", w: -1 }, { in: "flap", w: -1 }], name: "Left flaperon" },
  [FN.FLAPERON_RIGHT]: { kind: "flaperon", side: "right", mix: [{ in: "roll", w: 1 }, { in: "flap", w: -1 }], name: "Right flaperon" },
};

export function inferProfile(params: ReadonlyMap<string, number>, opts: { name?: string; outputs?: number; hasScripting?: boolean } = {}): Profile {
  const g = (n: string) => params.get(n);
  const p = emptyProfile(opts.name ?? "Imported from board");
  p.rc.roll = g("RCMAP_ROLL") ?? 1;
  p.rc.pitch = g("RCMAP_PITCH") ?? 2;
  p.rc.throttle = g("RCMAP_THROTTLE") ?? 3;
  p.rc.yaw = g("RCMAP_YAW") ?? 4;
  for (const ch of [p.rc.roll, p.rc.pitch, p.rc.throttle, p.rc.yaw]) {
    p.rc.reversed[ch] = g(`RC${ch}_REVERSED`) === 1;
    const [min, max, trim] = [g(`RC${ch}_MIN`), g(`RC${ch}_MAX`), g(`RC${ch}_TRIM`)];
    if (min !== undefined && max !== undefined && trim !== undefined) p.rc.ranges[ch] = { min, max, trim };
  }
  p.modes = { channel: g("FLTMODE_CH") ?? 8, slots: [1, 2, 3, 4, 5, 6].map((i) => g(`FLTMODE${i}`) ?? 0) };
  for (let ch = 1; ch <= 16; ch++) {
    const opt = g(`RC${ch}_OPTION`);
    if (opt === 208 && !p.flapChannel) p.flapChannel = ch;
    if (opt === 153) p.arming = { method: "switch", switchChannel: ch, rudderDisarm: false };
  }
  if (g("AHRS_ORIENTATION") !== undefined) p.orientation = g("AHRS_ORIENTATION");
  p.ports = portsFromBoard(params);
  // keep each port's baud as it is on the board (an import shouldn't change anything)
  p.portBaud = Object.fromEntries(Object.keys(p.ports).map((n) => [n, g(`SERIAL${n}_BAUD`)]).filter(([, v]) => v !== undefined));

  const blhMask = g("SERVO_BLH_MASK") ?? 0;
  const bdMask = g("SERVO_BLH_BDMASK") ?? 0;
  const otype = g("SERVO_BLH_OTYPE") ?? 0;
  const telemSerial = [1, 2, 3, 4, 5, 6, 7, 8].find((n) => g(`SERIAL${n}_PROTOCOL`) === 16);

  const outputs = opts.outputs ?? 16;
  for (let n = 1; n <= outputs; n++) {
    const fn = g(`SERVO${n}_FUNCTION`);
    if (fn === undefined || fn === 0 || fn === -1) continue;
    const common = {
      output: n, reversed: g(`SERVO${n}_REVERSED`) === 1,
      trim: g(`SERVO${n}_TRIM`), min: g(`SERVO${n}_MIN`), max: g(`SERVO${n}_MAX`),
    };
    if (fn === FN.THROTTLE || fn === FN.THROTTLE_LEFT || fn === FN.THROTTLE_RIGHT) {
      const dshot = (blhMask >> (n - 1)) & 1;
      const bidir = ((bdMask >> (n - 1)) & 1) === 1;
      const m: Motor = {
        id: `motor-s${n}`, name: fn === FN.THROTTLE ? "Motor" : fn === FN.THROTTLE_LEFT ? "Left motor" : "Right motor",
        output: n, position: fn === FN.THROTTLE ? "center" : fn === FN.THROTTLE_LEFT ? "left" : "right",
        protocol: dshot ? OTYPE_TO[otype] ?? "DSHOT300" : "PWM", bidir,
        telemetry: bidir ? "bidir" : telemSerial ? "serial" : "none", telemetrySerial: telemSerial,
        poles: g("SERVO_BLH_POLES") ?? 14,
      };
      p.motors.push(m);
      continue;
    }
    const nat = NATIVE[fn];
    if (nat) {
      p.surfaces.push({ id: `s${n}`, name: `${nat.name} (S${n})`, kind: nat.kind, side: nat.side, mix: nat.mix.map((t) => ({ ...t })), autoName: true, ...common });
    } else if (fn >= FN.RCIN1_SCALED && fn < FN.RCIN1_SCALED + 16) {
      const rc = fn - FN.RCIN1_SCALED + 1;
      p.surfaces.push({ id: `s${n}`, name: `RC${rc} mechanism (S${n})`, kind: "mechanism", mix: [{ in: `rc${rc}`, w: 1 }], failsafe: "hold", autoName: false, ...common });
    } else {
      // raw RCIN passthrough, scripting outputs, LEDs, alarms…: keep exactly as is
      p.surfaces.push({ id: `s${n}`, name: `Function ${fn} (S${n})`, kind: "fixed", fixedFunction: fn, mix: [], failsafe: "hold", autoName: false, ...common });
    }
  }

  const hs = opts.hasScripting ?? params.has("SCR_ENABLE");
  p.failsafe = { mode: hs ? "pose" : "glide", delayMs: Math.round((g("RC_FS_TIMEOUT") ?? 1) * 1000) + (g("HSK_FS_DLY") ?? 0) };
  const pwms = Array.from({ length: 16 }, (_, i) => g(`HSK_FS_PWM${i + 1}`) ?? 0);
  if (pwms.some((v) => v > 0)) p.failsafe.capturedPwm = pwms;
  if (g("HSK_RUD_ARM") === 1 && g("ARMING_RUDDER") === 0) p.arming = { method: "rudder-script", rudderDisarm: false };
  else if (p.arming.method !== "switch") p.arming = { method: hs ? "rudder-script" : "rudder-native", rudderDisarm: g("ARMING_RUDDER") === 2 };
  const laid = withLayout(p);
  return { ...laid, surfaces: laid.surfaces.map((s) => (s.kind === "fixed" ? s : normalizeSurface(s, laid.inputs))) };
}
