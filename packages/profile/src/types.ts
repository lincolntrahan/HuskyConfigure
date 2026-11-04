/**
 * The aircraft profile: what the airplane IS, not which parameters it needs.
 * The compiler (compile.ts) turns it into parameters; the wizard edits it.
 *
 * Surface sign convention (matches ArduPilot's own mixers): a positive surface command moves a
 * horizontal surface's trailing edge UP and a vertical surface's trailing edge RIGHT.
 * Physical servo direction is NOT part of the mix; it's SERVOn_REVERSED, found by the direction check.
 */

/** Axis inputs, as ArduPilot computes them (so they include FBWA/ACRO stabilization). */
export type Axis = "roll" | "pitch" | "yaw" | "flap" | "throttle";

/** A team-defined input read straight from an RC channel, e.g. a spoiler slider. */
export interface CustomInput {
  id: string;          // "spoiler"
  label: string;       // "Spoilers"
  rc: number;          // RC channel 1-16
  /** unipolar: channel low end = 0, high end = 1 (e.g. spoiler amount). bipolar: -1..1 around trim. */
  range: "unipolar" | "bipolar";
}

export interface MixTerm {
  /** an Axis, a CustomInput id, or "rcN" for a raw channel */
  in: string;
  /** weight, -1..1 */
  w: number;
  /** "linear" (default), or one-sided: "positive" keeps only w*x > 0, "negative" only < 0 */
  curve?: "linear" | "positive" | "negative";
}

export type SurfaceKind =
  | "aileron" | "elevator" | "rudder" | "flap" | "spoiler"
  | "elevon" | "ruddervator" | "flaperon" | "spoileron"
  | "steering" | "mechanism" | "fixed";

export interface Surface {
  id: string;
  name: string;
  kind: SurfaceKind;
  side?: "left" | "right" | "center";
  /** servo output number (1-based), unset until the Outputs step */
  output?: number;
  mix: MixTerm[];
  /** for kind "fixed": a raw SERVOn_FUNCTION (LEDs, alarm, …) */
  fixedFunction?: number;
  /** filled in by the wizard */
  reversed?: boolean;
  trim?: number;
  min?: number;
  max?: number;
  /** what this output does during the RC-loss failsafe (non-flight outputs) */
  failsafe?: "pose" | "hold" | "trim" | "min" | "max";
  /** where it sits on the top-down diagram (canvas units, see CANVAS in describe.ts) */
  pos?: Rect;
  /** stands up (rudder, steering): moves left/right instead of up/down */
  upright?: boolean;
  /** yaw-only upright surface that should act only on the ground (ArduPilot ground steering) */
  groundSteering?: boolean;
  /** name follows what the surface is (true until the user renames it) */
  autoName?: boolean;
}

export interface Rect { x: number; y: number; w: number; h: number }

export type MotorProtocol = "PWM" | "DSHOT150" | "DSHOT300" | "DSHOT600" | "DSHOT1200";

export interface Motor {
  id: string;
  name: string;
  output?: number;
  /** single motor = "center"; twin = left/right (differential thrust is a later feature) */
  position: "center" | "left" | "right";
  protocol: MotorProtocol;
  bidir: boolean;
  telemetry: "none" | "bidir" | "serial";
  /** SERIALn for a telemetry wire */
  telemetrySerial?: number;
  poles: number;
  pos?: Rect;
}

import type { PeripheralKind } from "./peripherals.ts";

export type Silhouette = "conventional" | "vtail" | "wing" | "none";

export type ReceiverKind = "keep" | "elrs-crsf" | "elrs-mavlink" | "sbus-rcin";

export interface Profile {
  schema: 1;
  name: string;
  notes?: string;
  /** which physical board this profile was set up on (calibrations belong to it) */
  board?: { target?: string; uid?: string; firmware?: string };
  /** AHRS_ORIENTATION: how the flight controller is mounted in this airframe (undefined = leave the board's) */
  orientation?: number;
  /** outline drawn behind the surfaces on the airframe diagram */
  silhouette?: Silhouette;

  /** legacy (before ports): kept so old profiles still load */
  receiver: { kind: ReceiverKind; serial?: number };
  /** device on each SERIALn ("keep" = leave the board's setting alone) */
  ports?: Record<string, PeripheralKind>;
  /** baud overrides per SERIALn (ArduPilot codes: 57, 115, 230, 460…) */
  portBaud?: Record<string, number>;
  /** RC channel numbers (1-based) for the four sticks, plus reversal and calibrated ranges */
  rc: {
    roll: number; pitch: number; throttle: number; yaw: number;
    reversed: Record<string, boolean>;
    ranges: Record<string, { min: number; max: number; trim: number }>;
  };
  /** flap input channel (ArduPilot flap RC option), if the plane has flaps */
  flapChannel?: number;
  inputs: CustomInput[];

  modes: { channel: number; slots: number[] };
  surfaces: Surface[];
  motors: Motor[];

  failsafe: {
    /** "pose" = husky.lua DBF pose (H7); "glide" = ArduPilot GLIDE only (F4 boards) */
    mode: "pose" | "glide";
    /** total time from link loss to the pose, ms (ArduPilot needs >= 500) */
    delayMs: number;
    /** per-output PWM captured from the board in the pose (index 0 = S1); 0 = leave alone */
    capturedPwm?: number[];
    capturedAt?: string;
  };

  arming: {
    method: "rudder-script" | "rudder-native" | "switch";
    switchChannel?: number;
    rudderDisarm: boolean;
  };

  /** physical checks the team has done, each bound to a hash of the parameters it depends on */
  verifications: Record<string, { hash: string; at: string }>;
  /** policy rules relaxed for this aircraft, with the reason */
  overrides: { rule: string; reason: string }[];
  /** raw parameters the team wants pinned (written and checked like everything else) */
  pinned: Record<string, number>;
}

export function emptyProfile(name = "New aircraft"): Profile {
  return {
    schema: 1, name,
    receiver: { kind: "keep" },
    rc: { roll: 1, pitch: 2, throttle: 3, yaw: 4, reversed: {}, ranges: {} },
    inputs: [],
    modes: { channel: 8, slots: [0, 0, 5, 5, 0, 0] },
    surfaces: [], motors: [],
    failsafe: { mode: "pose", delayMs: 1000 },
    arming: { method: "rudder-script", rudderDisarm: false },
    verifications: {}, overrides: [], pinned: {},
  };
}

export const MODE_NAMES: Record<number, string> = { 0: "MANUAL", 4: "ACRO", 5: "FBWA" };
