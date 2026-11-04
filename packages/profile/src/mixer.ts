/**
 * Surface mixing: which ArduPilot function implements a mix natively, and (for display and
 * predictions) what a mix outputs for given inputs. The TypeScript evaluation here mirrors
 * scripts/husky.lua; a SITL test checks they agree.
 */
import type { Axis, MixTerm, Profile, Surface } from "./types.ts";

export const FN = {
  DISABLED: 0, FLAP: 2, FLAP_AUTO: 3, AILERON: 4, ELEVATOR: 19, RUDDER: 21,
  FLAPERON_LEFT: 24, FLAPERON_RIGHT: 25, GROUND_STEERING: 26,
  RCIN1: 51, THROTTLE: 70, THROTTLE_LEFT: 73, THROTTLE_RIGHT: 74,
  ELEVON_LEFT: 77, ELEVON_RIGHT: 78, VTAIL_LEFT: 79, VTAIL_RIGHT: 80,
  SCRIPT1: 94, SERVO_TRIM: 135, RCIN1_SCALED: 140,
} as const;

const AXES: Axis[] = ["roll", "pitch", "yaw", "flap", "throttle"];
export const isAxis = (s: string): s is Axis => (AXES as string[]).includes(s);

export interface NativeMatch {
  fn: number;
  /** ArduPilot's own output has the opposite overall sign to the mix: start reversed */
  invert: boolean;
  label: string;
}

const sgn = (x: number) => (x < 0 ? -1 : 1);

/**
 * The ArduPilot function that reproduces this mix exactly, or undefined → scripted surface.
 * Only full-weight linear terms on axis inputs (or one raw/custom passthrough) match.
 */
export function nativeFunction(s: Surface, profile: Pick<Profile, "inputs">): NativeMatch | undefined {
  if (s.kind === "fixed") return s.fixedFunction !== undefined ? { fn: s.fixedFunction, invert: false, label: `function ${s.fixedFunction}` } : undefined;
  const terms = s.mix.filter((t) => t.w !== 0);
  if (terms.some((t) => (t.curve ?? "linear") !== "linear")) return undefined;
  if (terms.length === 1) {
    const t = terms[0]!;
    if (Math.abs(t.w) !== 1) return undefined;
    const inv = t.w < 0;
    switch (t.in) {
      case "roll": return { fn: FN.AILERON, invert: inv, label: "Aileron" };
      case "pitch": return { fn: FN.ELEVATOR, invert: inv, label: "Elevator" };
      case "yaw": return s.kind === "steering"
        ? { fn: FN.GROUND_STEERING, invert: inv, label: "Ground steering" }
        : { fn: FN.RUDDER, invert: inv, label: "Rudder" };
      // flap percent drives the range output toward MAX; "+ = up" means a downward flap is w = -1
      case "flap": return { fn: FN.FLAP_AUTO, invert: inv, label: "Flap" };
    }
    const rc = rcOf(t.in, profile);
    if (rc) return { fn: FN.RCIN1_SCALED + rc - 1, invert: inv, label: `RC${rc} passthrough` };
    return undefined;
  }
  if (terms.length === 2 && terms.every((t) => Math.abs(t.w) === 1 && isAxis(t.in))) {
    const w = Object.fromEntries(terms.map((t) => [t.in, t.w])) as Partial<Record<Axis, number>>;
    // channel_function_mixer: left = (in2 - in1), right = (in2 + in1); unreversed = up
    if (w.roll && w.pitch) {
      const same = sgn(w.roll) === sgn(w.pitch);
      return { fn: same ? FN.ELEVON_RIGHT : FN.ELEVON_LEFT, invert: w.pitch < 0, label: same ? "Elevon (right)" : "Elevon (left)" };
    }
    if (w.yaw && w.pitch) {
      const same = sgn(w.yaw) === sgn(w.pitch);
      return { fn: same ? FN.VTAIL_LEFT : FN.VTAIL_RIGHT, invert: w.pitch < 0, label: same ? "V-tail (left)" : "V-tail (right)" };
    }
    // flaperon_left = aileron + flap, flaperon_right = aileron - flap
    if (w.roll && w.flap) {
      const same = sgn(w.roll) === sgn(w.flap);
      return { fn: same ? FN.FLAPERON_LEFT : FN.FLAPERON_RIGHT, invert: w.roll < 0, label: same ? "Flaperon (left)" : "Flaperon (right)" };
    }
  }
  return undefined;
}

/**
 * What a scripted surface becomes if husky.lua stops: the native function of the plain part of
 * its mix (full-weight linear axis terms only; one-sided and custom-input terms are dropped,
 * never "un-curved"), or SERVOn_TRIM (hold at center) when nothing native is left.
 * The script drives the surface by overriding this function's output; when the override
 * stops being refreshed (~100 ms), ArduPilot's own function takes the output back.
 */
export function fallbackFunction(s: Surface, profile: Pick<Profile, "inputs">): NativeMatch {
  const plain = s.mix.filter((t) => (t.curve ?? "linear") === "linear" && isAxis(t.in) && Math.abs(t.w) === 1);
  const m = plain.length ? nativeFunction({ ...s, mix: plain }, profile) : undefined;
  return m ?? { fn: FN.SERVO_TRIM, invert: false, label: "hold at center" };
}

export function rcOf(input: string, profile: Pick<Profile, "inputs">): number | undefined {
  const m = /^rc(\d{1,2})$/.exec(input);
  if (m) return Number(m[1]);
  return profile.inputs.find((i) => i.id === input)?.rc;
}

export type InputValues = Partial<Record<string, number>>;

/** Mix output in -1..1 for the given input values (axes -1..1, flap/throttle 0..1). */
export function evalMix(mix: MixTerm[], inputs: InputValues): number {
  let v = 0;
  for (const t of mix) {
    let x = t.w * (inputs[t.in] ?? 0);
    if (t.curve === "positive") x = Math.max(0, x);
    if (t.curve === "negative") x = Math.min(0, x);
    v += x;
  }
  return Math.max(-1, Math.min(1, v));
}

/** Inputs a mix uses, for the direction check prompts. */
export function mixInputs(s: Surface): string[] {
  return [...new Set(s.mix.filter((t) => t.w !== 0).map((t) => t.in))];
}

// ---- encoding scripted mixes for husky.lua (see LAYOUT there) ----

/** Input ids understood by husky.lua: 1..5 axes, 100+N = raw RC channel N (bipolar), 200+N = unipolar. */
export function luaInputId(input: string, profile: Pick<Profile, "inputs">): number | undefined {
  const ai = AXES.indexOf(input as Axis);
  if (ai >= 0) return ai + 1;
  const ci = profile.inputs.find((i) => i.id === input);
  if (ci) return (ci.range === "unipolar" ? 200 : 100) + ci.rc;
  const m = /^rc(\d{1,2})$/.exec(input);
  if (m) return 100 + Number(m[1]);
  return undefined;
}

/** Pack one term into one exactly-representable float: id*1000 + curve*300... see husky.lua decode_term. */
export function encodeTerm(t: MixTerm, profile: Pick<Profile, "inputs">): number {
  const id = luaInputId(t.in, profile);
  if (id === undefined) throw new Error(`unknown mix input ${t.in}`);
  const curve = t.curve === "positive" ? 1 : t.curve === "negative" ? 2 : 0;
  const w = Math.round(Math.max(-1, Math.min(1, t.w)) * 100) + 100; // 0..200
  return id * 1000 + curve * 250 + w; // w < 250, curve < 4
}

export function decodeTerm(code: number): { id: number; curve: number; w: number } {
  const id = Math.floor(code / 1000);
  const rest = code - id * 1000;
  const curve = Math.floor(rest / 250);
  return { id, curve, w: (rest - curve * 250 - 100) / 100 };
}
