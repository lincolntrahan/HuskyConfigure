/**
 * Team policy: the tool's opinions, as data the team owns (a policy.json in the team repo
 * replaces DEFAULT_POLICY). Rules in CORE_RULES describe things that physically can't work
 * and can't be relaxed; everything else takes its severity from here and can be overridden
 * per aircraft with a written reason.
 */
export type Severity = "error" | "warning" | "info" | "off";

export interface Policy {
  name: string;
  /** Plane mode numbers allowed on the switch and from the GCS */
  allowedModes: number[];
  /** default link-loss → pose delay */
  failsafeDelayMs: number;
  severity: Record<string, Severity>;
}

export const DEFAULT_POLICY: Policy = {
  name: "HuskyConfigure defaults",
  allowedModes: [0, 5, 4],
  failsafeDelayMs: 1000,
  severity: {
    "mode-not-allowed": "error",
    "failsafe-not-captured": "error",
    "arming-gate-off": "error",
    "surface-no-output": "warning",
    "trim-off-center": "warning",
    "rudder-disarm": "warning",
    "no-motor": "warning",
    "bidir-target": "warning",
    "no-ranges": "warning",
  },
};

export const CORE_RULES = new Set([
  "output-conflict", "output-range", "dshot-timer", "trim-order", "rcmap-dup", "too-many-scripted",
  "scripting-missing",
]);
