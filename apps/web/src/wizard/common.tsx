import { useState, useSyncExternalStore, type ReactNode } from "react";
import { diffCompiled, type Finding, type StepId } from "@husky/profile";
import { session, useMetadata, useSession } from "../state.ts";
import { Review } from "../components/Review.tsx";
import { confirmProps, propsConfirmed, type Derived } from "./store.ts";

export function useLive() {
  return useSyncExternalStore(session.subscribeLive, () => session.live);
}

export function Findings({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null;
  return (
    <div className="findings">
      {findings.map((f, i) => (
        <div key={i} className={`finding ${f.severity}`}>
          <strong>{f.severity === "error" ? "Must fix" : f.severity === "warning" ? "Check" : "Note"}</strong> {f.message}
          {f.overridden && <div className="muted">Accepted for this aircraft: {f.overridden}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * Frame for one wizard step: explanation, the step's findings, its content, and an
 * "Apply to board" button that writes only the parameters this step owns (through Review).
 */
export function StepShell({ title, intro, steps, d, children, advanced, applyLabel }: {
  title: string; intro?: ReactNode; steps?: StepId[]; d: Derived; children?: ReactNode; advanced?: ReactNode; applyLabel?: string;
}) {
  const s = useSession();
  const meta = useMetadata();
  const [reviewing, setReviewing] = useState(false);
  const diff = steps ? diffCompiled(d.compiled, d.board, steps) : [];
  const absent = steps ? d.compiled.absent.filter((k) => steps.includes(d.compiled.owner[k]!)) : [];
  const mine = d.findings.filter((f) => steps?.includes(f.step as StepId) || (f.step === "airframe" && title === "Airframe"));

  if (reviewing) {
    return <Review items={diff} meta={meta} title={title} onCancel={() => setReviewing(false)} onDone={() => setReviewing(false)} />;
  }
  return (
    <div className="step">
      <h1>{title}</h1>
      {intro && <div className="intro">{intro}</div>}
      <Findings findings={mine} />
      {children}
      {advanced && <details className="adv"><summary>Advanced</summary>{advanced}</details>}
      {steps && (
        <div className="apply">
          {diff.length === 0
            ? <span className="ok-text">✓ The board already matches this step.</span>
            : <button className="primary" disabled={!!s.busy} onClick={() => setReviewing(true)}>{applyLabel ?? "Apply to board"}: review {diff.length} change{diff.length === 1 ? "" : "s"}</button>}
          {absent.length > 0 && (
            <span className="muted">
              {absent.length} setting{absent.length === 1 ? "" : "s"} ({absent.slice(0, 3).join(", ")}{absent.length > 3 ? "…" : ""}) {absent.length === 1 ? "isn't" : "aren't"} on the board right now
              {absent.some((k) => k.startsWith("HSK_")) ? "; the companion script adds its settings once it runs" : absent.some((k) => k.startsWith("SERVO_BLH")) ? "; this firmware has no DShot settings (e.g. the simulator)" : "; some appear only after a reboot"}.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Props-off gate for any step that powers servos or can spin the motor. */
export function PropsGate({ children }: { children: ReactNode }) {
  useSession();
  const [, force] = useState(0);
  if (propsConfirmed()) return <>{children}</>;
  return (
    <div className="gate">
      <h3>Before this step</h3>
      <ul>
        <li><strong>Remove the propeller.</strong></li>
        <li>Connect the flight battery (USB alone usually doesn't power the servos).</li>
        <li>Keep hands and cables clear of the control surfaces.</li>
      </ul>
      <button className="primary" onClick={() => { confirmProps(); force((x) => x + 1); }}>The propeller is off</button>
    </div>
  );
}

export function Bar({ value, min = 1000, max = 2000, mark }: { value: number; min?: number; max?: number; mark?: number }) {
  const pct = (v: number) => `${Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))}%`;
  return (
    <span className="pwmbar">
      <span className="fill" style={{ width: pct(value) }} />
      {mark !== undefined && <span className="mark" style={{ left: pct(mark) }} />}
    </span>
  );
}

export function RcBars({ channels = 16, highlight }: { channels?: number; highlight?: number[] }) {
  const live = useLive();
  return (
    <div className="rcbars">
      {Array.from({ length: channels }, (_, i) => (
        <div key={i} className={`rcrow ${highlight?.includes(i + 1) ? "hl" : ""}`}>
          <span className="mono">CH{i + 1}</span>
          <Bar value={live.rc[i] ?? 0} />
          <span className="mono">{live.rc[i] || "—"}</span>
        </div>
      ))}
    </div>
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
