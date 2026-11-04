import { MAX_SCRIPTED, type BoardFacts, type Compiled, type StepId } from "./compile.ts";
import { CORE_RULES, DEFAULT_POLICY, type Policy, type Severity } from "./policy.ts";
import { MODE_NAMES, type Profile } from "./types.ts";

export interface Finding {
  rule: string;
  severity: Severity;
  step: StepId | "airframe";
  message: string;
  /** set when a per-aircraft override relaxed this finding */
  overridden?: string;
}

export interface RuleContext extends BoardFacts {
  /** servo outputs grouped by hardware timer (from the board's hwdef), if known */
  timerGroups?: number[][];
  target?: string;
}

export function evaluate(profile: Profile, c: Compiled, ctx: RuleContext, policy: Policy = DEFAULT_POLICY): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, step: Finding["step"], message: string) => {
    const core = CORE_RULES.has(rule);
    let severity: Severity = core ? "error" : policy.severity[rule] ?? "warning";
    if (severity === "off") return;
    const ov = !core ? profile.overrides.find((o) => o.rule === rule) : undefined;
    if (ov) severity = "info";
    out.push({ rule, severity, step, message, overridden: ov?.reason });
  };

  // ---- outputs ----
  const byOutput = new Map<number, string[]>();
  for (const s of profile.surfaces) if (s.output) byOutput.set(s.output, [...(byOutput.get(s.output) ?? []), s.name]);
  for (const m of profile.motors) if (m.output) byOutput.set(m.output, [...(byOutput.get(m.output) ?? []), m.name]);
  for (const [o, names] of byOutput) {
    if (names.length > 1) add("output-conflict", "outputs", `Output S${o} is assigned to ${names.join(" and ")}.`);
    if (o > ctx.outputs) add("output-range", "outputs", `${names[0]} is on S${o}, but this board only has ${ctx.outputs} outputs.`);
  }
  for (const s of profile.surfaces) if (!s.output && s.kind !== "fixed") add("surface-no-output", "outputs", `${s.name} isn't plugged into an output yet.`);
  if (!profile.motors.some((m) => m.output)) add("no-motor", "outputs", "No motor output is assigned.");

  if (ctx.timerGroups) {
    for (const mo of profile.motors.filter((m) => m.output && m.protocol !== "PWM")) {
      const group = ctx.timerGroups.find((g) => g.includes(mo.output!));
      if (!group) continue;
      for (const o of group) {
        if (o === mo.output) continue;
        const other = byOutput.get(o)?.[0];
        const otherMotor = profile.motors.find((m) => m.output === o);
        if (other && !(otherMotor && otherMotor.protocol === mo.protocol)) {
          add("dshot-timer", "outputs", `${mo.name} on S${mo.output} uses DShot, and S${o} (${other}) shares its hardware timer, so S${o} can't drive a normal servo. Move ${other} to an output in another group.`);
        }
      }
    }
  }
  for (const mo of profile.motors) {
    if (mo.bidir && ctx.target && !/bdshot/i.test(ctx.target)) {
      add("bidir-target", "motor", `Bidirectional DShot is on, but the firmware is "${ctx.target}" (not a -bdshot build). Flash the -bdshot firmware or turn it off.`);
    }
  }

  // ---- trims ----
  for (const s of profile.surfaces) {
    const { min, trim, max } = s;
    if (min !== undefined && max !== undefined && !(min < max)) add("trim-order", "trims", `${s.name}: the lower limit must be below the upper limit.`);
    if (trim !== undefined && ((min !== undefined && trim < min) || (max !== undefined && trim > max))) add("trim-order", "trims", `${s.name}: center is outside its limits.`);
    if (trim !== undefined && (trim < 1450 || trim > 1550) && s.kind !== "mechanism") {
      add("trim-off-center", "trims", `${s.name}: center is ${trim} µs. Outside 1450–1550, adjust the linkage instead so the servo keeps its full travel both ways.`);
    }
  }

  // ---- sticks / modes ----
  const sticks = [profile.rc.roll, profile.rc.pitch, profile.rc.throttle, profile.rc.yaw];
  if (new Set(sticks).size !== 4) add("rcmap-dup", "sticks", "Two sticks are mapped to the same RC channel.");
  if (sticks.includes(profile.modes.channel)) add("rcmap-dup", "modes", `The mode switch (channel ${profile.modes.channel}) is also a stick channel.`);
  if (profile.flapChannel && [...sticks, profile.modes.channel].includes(profile.flapChannel)) add("rcmap-dup", "sticks", "The flap channel is also used for a stick or the mode switch.");
  if (!Object.keys(profile.rc.ranges).length) add("no-ranges", "sticks", "Stick ranges haven't been calibrated.");
  profile.modes.slots.forEach((m, i) => {
    if (!policy.allowedModes.includes(m)) add("mode-not-allowed", "modes", `Switch position ${i + 1} is ${MODE_NAMES[m] ?? `mode ${m}`}, which team policy doesn't allow.`);
  });

  // ---- scripting / failsafe / arming ----
  if (c.scripted.length > MAX_SCRIPTED) add("too-many-scripted", "airframe", `${c.scripted.length} surfaces need the scripted mixer; at most ${MAX_SCRIPTED} are supported.`);
  if (c.scripted.length && !ctx.hasScripting) add("scripting-missing", "airframe", `${c.scripted.map((s) => profile.surfaces.find((x) => x.id === s.surfaceId)?.name).join(", ")} need scripting, which this board's firmware doesn't have. Change the mix or use an H7 board.`);
  if (profile.failsafe.mode === "pose" && !ctx.hasScripting) add("scripting-missing", "failsafe", "The DBF failsafe pose needs scripting, which this board doesn't have. Use GLIDE.");
  if (profile.failsafe.mode === "pose" && ctx.hasScripting && !profile.failsafe.capturedPwm) add("failsafe-not-captured", "failsafe", "The failsafe pose hasn't been captured from the board yet.");
  if (ctx.hasScripting && profile.arming.method !== "rudder-script") add("arming-gate-off", "arming", "Arming isn't going through the HuskyConfigure script, so a missing or crashed script won't stop the plane from arming.");
  if (profile.arming.rudderDisarm) add("rudder-disarm", "arming", "Rudder disarm can disarm in flight if ArduPilot wrongly thinks the plane has landed.");

  return out;
}
