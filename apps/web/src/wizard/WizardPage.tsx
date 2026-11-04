import { useState } from "react";
import { diffCompiled, mixInputs, type Profile, type StepId } from "@husky/profile";
import { useSession } from "../state.ts";
import { useLive } from "./common.tsx";
import { check, useDerived, useProfile, type Derived } from "./store.ts";
import { StartStep, SticksStep, ModesStep } from "./stepsSetup.tsx";
import { PeripheralsStep } from "./stepsPeripherals.tsx";
import { ScriptStep, BUNDLED_VERSION } from "./stepsAirframe.tsx";
import { AirframeOutputsStep } from "./airframe.tsx";
import { DirectionsStep, StabilizeStep } from "./stepsChecks.tsx";
import { FailsafeStep, ArmingStep, FinishStep } from "./stepsSafety.tsx";

type Status = "done" | "todo" | "stale" | "error";
interface StepDef { id: string; label: string; owns: StepId[]; Comp: (props: { p: Profile; d: Derived }) => JSX.Element }

const STEPS: StepDef[] = [
  { id: "receiver", label: "Peripherals", owns: ["receiver"], Comp: PeripheralsStep },
  { id: "sticks", label: "Sticks", owns: ["sticks"], Comp: SticksStep },
  { id: "modes", label: "Flight modes", owns: ["modes"], Comp: ModesStep },
  { id: "airframe", label: "Airframe and outputs", owns: ["outputs", "motor", "directions", "trims"], Comp: AirframeOutputsStep },
  { id: "script", label: "Companion script", owns: [], Comp: ScriptStep },
  { id: "directions", label: "Surface directions", owns: ["directions"], Comp: DirectionsStep },
  { id: "stabilize", label: "Stabilization check", owns: [], Comp: StabilizeStep },
  { id: "failsafe", label: "Failsafe", owns: ["failsafe"], Comp: FailsafeStep },
  { id: "arming", label: "Arming", owns: ["arming"], Comp: ArmingStep },
  { id: "finish", label: "Finish", owns: [], Comp: FinishStep },
];

function statusOf(step: StepDef, p: Profile, d: Derived, hsk: { version: number; t: number } | undefined, rcOk: boolean): Status {
  const errs = d.findings.some((f) => f.severity === "error" && (step.owns.includes(f.step as StepId) || (f.step === "airframe" && step.id === "airframe")));
  if (errs) return "error";
  const diff = step.owns.length ? diffCompiled(d.compiled, d.board, step.owns).length : 0;
  switch (step.id) {
    case "receiver": return !diff ? "done" : "todo";
    case "sticks": return Object.keys(p.rc.ranges).length && !diff ? "done" : "todo";
    case "airframe": return p.surfaces.length && !diff && p.surfaces.every((s) => s.output || s.kind === "fixed") ? "done" : "todo";
    case "script": return !d.facts.hasScripting || (hsk && Date.now() - hsk.t < 4000 && hsk.version === BUNDLED_VERSION) ? "done" : "todo";
    case "directions": {
      const sts = p.surfaces.filter((s) => s.output && s.kind !== "fixed" && mixInputs(s).some((i) => i !== "throttle")).map((s) => check(`direction:${s.id}`, p));
      if (!sts.length) return "todo";
      return sts.every((x) => x === "ok") && !diff ? "done" : sts.some((x) => x === "stale") ? "stale" : "todo";
    }
    case "stabilize": { const c = check("stabilize", p); return c === "ok" ? "done" : c; }
    case "failsafe": { const c = check("failsafe", p); return c === "ok" && !diff ? "done" : c === "stale" ? "stale" : "todo"; }
    case "finish": return d.findings.some((f) => f.severity === "error") ? "todo" : "done";
    default: return diff ? "todo" : "done";
  }
}

// survives the page remounting during a reboot/reconnect
let lastStep = "start";

const ICON: Record<Status, string> = { done: "✓", todo: "○", stale: "!", error: "✕" };

export function WizardPage() {
  useSession();
  const live = useLive();
  const p = useProfile();
  const d = useDerived(p);
  const [step, setStepState] = useState<string>(lastStep);
  const setStep = (x: string) => { lastStep = x; setStepState(x); };
  const rcOk = live.rcCount > 0 && live.rc.slice(0, 4).some((v) => v > 800);

  const cur = STEPS.find((x) => x.id === step);
  return (
    <div className="wizard">
      <aside className="steps-nav">
        <button className={`wstep ${step === "start" ? "active" : ""}`} onClick={() => setStep("start")}>
          <span className={`ico ${p ? "done" : "todo"}`}>{p ? ICON.done : ICON.todo}</span> Aircraft
        </button>
        {STEPS.map((x) => {
          const st = p && d ? statusOf(x, p, d, live.hsk, rcOk) : "todo";
          return (
            <button key={x.id} disabled={!p} className={`wstep ${step === x.id ? "active" : ""}`} onClick={() => setStep(x.id)}>
              <span className={`ico ${st}`}>{ICON[st]}</span> {x.label}
            </button>
          );
        })}
      </aside>
      <section className="wizard-main">
        {step === "start" || !p || !d ? <StartStep p={p} d={d} /> : cur ? <cur.Comp p={p} d={d} /> : null}
        {p && (
          <div className="row nav-buttons">
            {(() => {
              const i = step === "start" ? -1 : STEPS.findIndex((x) => x.id === step);
              return (
                <>
                  {i >= 0 && <button onClick={() => setStep(i === 0 ? "start" : STEPS[i - 1]!.id)}>← Back</button>}
                  {i < STEPS.length - 1 && <button className="primary" onClick={() => setStep(STEPS[i + 1]!.id)}>Next: {STEPS[i + 1]!.label} →</button>}
                </>
              );
            })()}
          </div>
        )}
      </section>
    </div>
  );
}
