/**
 * Turning a surface's mix into words and back, so the editor never shows signs or weights:
 * "When you roll right, this goes Down (100%)". Also: what kind of surface a mix is, which
 * side of the plane it's on (from where it sits on the diagram), its suggested name, and a
 * default diagram layout for profiles that don't have one.
 */
import { isAxis, rcOf } from "./mixer.ts";
import type { CustomInput, MixTerm, Motor, Profile, Rect, Surface, SurfaceKind } from "./types.ts";

/** Diagram canvas: nose at the top, tail at the bottom, centerline at x = 500. */
export const CANVAS = { w: 1000, h: 560, center: 500 };

export function sideOf(s: Pick<Surface, "pos" | "side">): "left" | "right" | "center" {
  if (!s.pos) return s.side ?? "center";
  const cx = s.pos.x + s.pos.w / 2;
  return cx < CANVAS.center - 30 ? "left" : cx > CANVAS.center + 30 ? "right" : "center";
}

export function isUpright(s: Pick<Surface, "upright" | "kind">): boolean {
  return s.upright ?? (s.kind === "rudder" || s.kind === "steering");
}

/** What a surface is, judged only by what moves it. */
export function inferKind(s: Pick<Surface, "mix" | "upright" | "kind" | "fixedFunction" | "groundSteering">, inputs: CustomInput[]): SurfaceKind {
  if (s.kind === "fixed" && s.fixedFunction !== undefined) return "fixed";
  const used = new Set(s.mix.filter((t) => t.w !== 0).map((t) => t.in));
  const custom = [...used].filter((i) => !isAxis(i));
  const has = (a: string) => used.has(a);
  const upright = s.upright ?? false;
  if (used.size === 0) return s.kind === "fixed" ? "fixed" : "mechanism";
  if (custom.length && !has("roll") && !has("pitch") && !has("yaw") && !has("flap")) {
    const ci = inputs.find((i) => i.id === custom[0]);
    return ci?.range === "unipolar" && /spoil|brake/i.test(ci.label + ci.id) ? "spoiler" : "mechanism";
  }
  if (has("roll") && custom.length) return "spoileron";
  if (has("roll") && has("pitch")) return "elevon";
  if (has("pitch") && has("yaw")) return "ruddervator";
  if (has("roll") && has("flap")) return "flaperon";
  if (has("roll")) return "aileron";
  if (has("pitch")) return "elevator";
  if (has("yaw")) return upright ? (s.groundSteering ? "steering" : "rudder") : "rudder";
  if (has("flap")) return "flap";
  return "mechanism";
}

const KIND_LABEL: Record<SurfaceKind, string> = {
  aileron: "aileron", elevator: "elevator", rudder: "rudder", flap: "flap", spoiler: "spoiler",
  elevon: "elevon", ruddervator: "ruddervator", flaperon: "flaperon", spoileron: "spoileron",
  steering: "steering", mechanism: "mechanism", fixed: "fixed output",
};
export const kindLabel = (k: SurfaceKind) => KIND_LABEL[k];

export function suggestName(s: Surface): string {
  const side = sideOf(s);
  const label = KIND_LABEL[s.kind];
  const cap = (x: string) => x[0]!.toUpperCase() + x.slice(1);
  return side === "center" ? cap(label) : `${cap(side)} ${label}`;
}

/** Keep the derived fields (kind, side, auto name) in step with the mix and position. */
export function normalizeSurface(s: Surface, inputs: CustomInput[]): Surface {
  const kind = inferKind(s, inputs);
  const next: Surface = { ...s, kind, side: sideOf(s) };
  if (s.autoName !== false) next.name = suggestName(next);
  return next;
}

// ---- words for each input ----

export interface InputQuestion { when: string; plus: string; minus: string }

export function inputLabel(input: string, inputs: CustomInput[]): string {
  switch (input) {
    case "roll": return "Roll"; case "pitch": return "Pitch"; case "yaw": return "Yaw";
    case "flap": return "Flap"; case "throttle": return "Throttle";
  }
  const ci = inputs.find((i) => i.id === input);
  if (ci) return `${ci.label} (RC${ci.rc})`;
  const rc = rcOf(input, { inputs });
  return rc ? `RC${rc}` : input;
}

/** The question the inspector asks for an input on a surface, and the two answers. */
export function inputQuestion(input: string, s: Pick<Surface, "upright" | "kind">, inputs: CustomInput[]): InputQuestion {
  const up = isUpright(s);
  const [plus, minus] = up ? ["Right", "Left"] : ["Up", "Down"];
  const ci = inputs.find((i) => i.id === input);
  const when =
    input === "roll" ? "When you roll right" :
    input === "pitch" ? "When you pull back (nose up)" :
    input === "yaw" ? "When you push right rudder" :
    input === "flap" ? "With full flaps" :
    input === "throttle" ? "At full throttle" :
    ci ? (ci.range === "unipolar" ? `When ${ci.label} is on` : `When ${ci.label} is up`) :
    `When RC${rcOf(input, { inputs })} is high`;
  return { when, plus, minus };
}

export type OneWay = "both" | "plus" | "minus";
export interface TermUi { dir: 1 | -1; amount: number; oneWay: OneWay }

export function termToUi(t: MixTerm): TermUi {
  return { dir: t.w < 0 ? -1 : 1, amount: Math.abs(t.w), oneWay: t.curve === "positive" ? "plus" : t.curve === "negative" ? "minus" : "both" };
}

export function uiToTerm(input: string, u: TermUi): MixTerm {
  const t: MixTerm = { in: input, w: u.dir * Math.round(Math.max(0, Math.min(1, u.amount)) * 100) / 100 };
  if (u.oneWay === "plus") t.curve = "positive";
  if (u.oneWay === "minus") t.curve = "negative";
  return t;
}

/** The direction a surface sensibly moves for an input, given where it is. */
export function defaultDirection(input: string, s: Pick<Surface, "pos" | "side" | "upright" | "kind">): 1 | -1 {
  const side = sideOf(s);
  if (input === "roll") return side === "left" ? -1 : 1;           // roll right: left wing surfaces go down
  if (input === "pitch") return 1;                                  // pull back: tail surfaces go up
  if (input === "yaw") return isUpright(s) ? 1 : side === "right" ? -1 : 1; // V-tail: right half goes down
  if (input === "flap") return -1;                                  // flaps go down
  return 1;
}

export function addInput(s: Surface, input: string, profile: Pick<Profile, "inputs">): Surface {
  if (s.mix.some((t) => t.in === input)) return s;
  const amount = s.mix.length && !isAxis(input) ? 0.5 : 1;
  return normalizeSurface({ ...s, mix: [...s.mix, uiToTerm(input, { dir: defaultDirection(input, s), amount, oneWay: "both" })] }, profile.inputs);
}

/** Every input is named: raw "rcN" mix terms become a named input "Channel N". */
export function namedInputsOnly(p: Profile): Profile {
  const raw = new Set<number>();
  for (const s of p.surfaces) for (const t of s.mix) { const m = /^rc(\d{1,2})$/.exec(t.in); if (m) raw.add(Number(m[1])); }
  if (!raw.size) return p;
  const inputs = [...p.inputs];
  const idFor = new Map<number, string>();
  for (const ch of raw) {
    const existing = inputs.find((i) => i.rc === ch);
    if (existing) { idFor.set(ch, existing.id); continue; }
    const id = `ch${ch}`;
    inputs.push({ id, label: `Channel ${ch}`, rc: ch, range: "bipolar" });
    idFor.set(ch, id);
  }
  const surfaces = p.surfaces.map((s) => ({ ...s, mix: s.mix.map((t) => { const m = /^rc(\d{1,2})$/.exec(t.in); return m ? { ...t, in: idFor.get(Number(m[1]))! } : t; }) }));
  return { ...p, inputs, surfaces };
}

// ---- layout ----

const DEFAULT_POS: Partial<Record<SurfaceKind, Record<"left" | "right" | "center", Rect>>> = {
  aileron: { left: { x: 90, y: 252, w: 230, h: 28 }, right: { x: 680, y: 252, w: 230, h: 28 }, center: { x: 400, y: 252, w: 200, h: 28 } },
  spoileron: { left: { x: 90, y: 252, w: 230, h: 28 }, right: { x: 680, y: 252, w: 230, h: 28 }, center: { x: 400, y: 252, w: 200, h: 28 } },
  flaperon: { left: { x: 90, y: 252, w: 300, h: 28 }, right: { x: 610, y: 252, w: 300, h: 28 }, center: { x: 400, y: 252, w: 200, h: 28 } },
  flap: { left: { x: 330, y: 252, w: 140, h: 28 }, right: { x: 530, y: 252, w: 140, h: 28 }, center: { x: 430, y: 252, w: 140, h: 28 } },
  spoiler: { left: { x: 210, y: 205, w: 120, h: 18 }, right: { x: 670, y: 205, w: 120, h: 18 }, center: { x: 440, y: 205, w: 120, h: 18 } },
  elevator: { left: { x: 340, y: 500, w: 140, h: 24 }, right: { x: 520, y: 500, w: 140, h: 24 }, center: { x: 350, y: 500, w: 300, h: 24 } },
  ruddervator: { left: { x: 330, y: 478, w: 150, h: 24 }, right: { x: 520, y: 478, w: 150, h: 24 }, center: { x: 420, y: 478, w: 160, h: 24 } },
  elevon: { left: { x: 120, y: 330, w: 300, h: 30 }, right: { x: 580, y: 330, w: 300, h: 30 }, center: { x: 420, y: 330, w: 160, h: 30 } },
  rudder: { left: { x: 466, y: 400, w: 20, h: 80 }, right: { x: 514, y: 400, w: 20, h: 80 }, center: { x: 490, y: 400, w: 20, h: 80 } },
  steering: { left: { x: 440, y: 520, w: 20, h: 30 }, right: { x: 540, y: 520, w: 20, h: 30 }, center: { x: 490, y: 522, w: 20, h: 30 } },
};

export function defaultPos(s: Surface, index = 0): Rect {
  const side = s.side ?? "center";
  const p = DEFAULT_POS[s.kind]?.[side];
  if (p) return { ...p };
  return { x: 620 + (index % 3) * 110, y: 80 + Math.floor(index / 3) * 60, w: 90, h: 36 };
}

export function defaultMotorPos(i = 0, position: Motor["position"] = "center"): Rect {
  if (position === "left") return { x: 300, y: 120, w: 60, h: 34 };
  if (position === "right") return { x: 640, y: 120, w: 60, h: 34 };
  return { x: 470 + i * 70, y: 6, w: 60, h: 34 };
}

/**
 * Give every surface and motor a diagram position, and turn intent-free imported mixes into
 * physical intent: ArduPilot's plain Aileron function is the same on both wings, so an
 * imported pair is split left/right here and the left one is told it moves Down on roll right.
 * Only the intent changes; the compiled output function and reversal stay exactly the same.
 */
export function withLayout(p0: Profile): Profile {
  const p = namedInputsOnly(p0);
  let misc = 0;
  let aileronCount = 0;
  const surfaces = p.surfaces.map((s) => {
    if (s.pos) return s.upright === undefined ? { ...s, upright: s.kind === "rudder" || s.kind === "steering" } : s;
    let x: Surface = { ...s, upright: s.upright ?? (s.kind === "rudder" || s.kind === "steering") };
    if (!x.side || x.side === "center") {
      if (x.kind === "aileron" || x.kind === "spoileron" || x.kind === "flap") {
        x.side = aileronCount++ % 2 === 0 ? "left" : "right";
        // intent: on roll right the left one goes down; flaps always go down
        x.mix = x.mix.map((t) => t.in === "roll" ? { ...t, w: (x.side === "left" ? -1 : 1) * Math.abs(t.w) } : t.in === "flap" ? { ...t, w: -Math.abs(t.w) } : t);
      }
    }
    const isMisc = !DEFAULT_POS[x.kind];
    x.pos = defaultPos(x, isMisc ? misc++ : 0);
    return x;
  });
  const motors = p.motors.map((m, i) => (m.pos ? m : { ...m, pos: defaultMotorPos(i, m.position) }));
  const silhouette = p.silhouette ?? (surfaces.some((s) => s.kind === "elevon") ? "wing" : surfaces.some((s) => s.kind === "ruddervator") ? "vtail" : "conventional");
  return { ...p, surfaces, motors, silhouette };
}
