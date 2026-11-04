import { useEffect, useState } from "react";
import { diffCompiled, evalMix, isUpright, MODE_NAMES, type Profile, type StepId } from "@husky/profile";
import { session, useMetadata, useSession } from "../state.ts";
import { Review } from "../components/Review.tsx";
import { Findings, PropsGate, StepShell, sleep, useLive } from "./common.tsx";
import { boardMap, check, downloadJson, passCheck, updateProfile, type Derived } from "./store.ts";
import { BUNDLED_VERSION } from "./stepsAirframe.tsx";
import { Help } from "../components/Help.tsx";

/** Inputs in the DBF pose: full right roll, full up elevator, full right rudder, full flaps, throttle closed, extras off. */
const POSE_INPUTS: Record<string, number> = { roll: 1, pitch: 1, yaw: 1, flap: 1, throttle: 0 };

function describePose(p: Profile) {
  return p.surfaces.filter((s) => s.output).map((s) => {
    const mode = s.failsafe ?? (s.kind === "mechanism" || s.kind === "fixed" ? "hold" : "pose");
    if (mode !== "pose") return { s, text: mode === "hold" ? "stays where it is" : mode === "trim" ? "goes to center" : `goes to its ${mode === "min" ? "low" : "high"} end` };
    const v = evalMix(s.mix, POSE_INPUTS);
    const dir = Math.abs(v) < 0.05 ? "neutral" : isUpright(s) ? (v > 0 ? "RIGHT" : "LEFT") : (v > 0 ? "UP" : "DOWN");
    return { s, text: dir === "neutral" ? "neutral / stowed" : `fully ${dir}` };
  });
}

// ---------------- Failsafe ----------------
type FsPhase = "idle" | "capturing" | "off" | "look" | "on" | "glide-off" | "done" | "fail";

export function FailsafeStep({ p, d }: { p: Profile; d: Derived }) {
  const s = useSession();
  const live = useLive();
  const [phase, setPhase] = useState<FsPhase>("idle");
  const [msg, setMsg] = useState<string>();
  const pose = p.failsafe.mode === "pose" && d.facts.hasScripting;
  const scriptOk = live.hsk && Date.now() - live.hsk.t < 4000 && live.hsk.version === BUNDLED_VERSION;
  const captured = p.failsafe.capturedPwm;
  const pending = diffCompiled(d.compiled, d.board, ["failsafe"]);
  const earlier = diffCompiled(d.compiled, d.board, ["outputs", "directions", "trims", "sticks"]);
  const st = check("failsafe", p);

  async function capture() {
    setPhase("capturing"); setMsg(undefined);
    try {
      if (s.mode !== 0) await session.setMode(0);
      const b = boardMap();
      const end = (ch: number, high: boolean) => (high !== (b.get(`RC${ch}_REVERSED`) === 1) ? b.get(`RC${ch}_MAX`) ?? 1900 : b.get(`RC${ch}_MIN`) ?? 1100);
      const ov: Record<number, number> = {
        [p.rc.roll]: end(p.rc.roll, true), [p.rc.pitch]: end(p.rc.pitch, true),
        [p.rc.yaw]: end(p.rc.yaw, true), [p.rc.throttle]: end(p.rc.throttle, false),
      };
      if (p.flapChannel) ov[p.flapChannel] = end(p.flapChannel, true);
      for (const i of p.inputs) ov[i.rc] = i.range === "unipolar" ? end(i.rc, false) : b.get(`RC${i.rc}_TRIM`) ?? 1500;
      session.startOverride(ov);
      await sleep(1500);
      const out = [...session.live.servo];
      await session.stopOverride();
      const pwms = Array.from({ length: 16 }, () => 0);
      for (const m of p.motors) if (m.output) pwms[m.output - 1] = out[m.output - 1] ?? 0;
      for (const x of p.surfaces) {
        if (!x.output) continue;
        const mode = x.failsafe ?? (x.kind === "mechanism" || x.kind === "fixed" ? "hold" : "pose");
        const n = x.output;
        pwms[n - 1] = mode === "pose" ? out[n - 1] ?? 0 : mode === "trim" ? b.get(`SERVO${n}_TRIM`)! : mode === "min" ? b.get(`SERVO${n}_MIN`)! : mode === "max" ? b.get(`SERVO${n}_MAX`)! : 0;
      }
      if (!pwms.some((v) => v > 0)) throw new Error("no outputs reported. Is the board sending servo outputs?");
      updateProfile((x) => ({ ...x, failsafe: { ...x.failsafe, capturedPwm: pwms, capturedAt: new Date().toISOString() } }));
      setPhase("idle");
    } catch (e) {
      await session.stopOverride();
      setMsg(`Capture failed: ${(e as Error).message}`); setPhase("fail");
    }
  }

  async function simulateTx(on: boolean) {
    await session.write([{ name: "SIM_RC_FAIL", value: on ? 0 : 1 }], on ? "Simulator: transmitter on" : "Simulator: transmitter off");
  }

  // watch the test
  useEffect(() => {
    if (phase === "off" && captured) {
      const match = captured.every((v, i) => !v || Math.abs((live.servo[i] ?? 0) - v) <= 5);
      if (live.hsk?.state === 1 && match) setPhase("look");
    }
    if (phase === "on" && live.hsk && live.hsk.state !== 1) { passCheck("failsafe"); setPhase("done"); }
    if (phase === "glide-off" && s.mode === 5) { passCheck("failsafe"); setPhase("done"); }
  }, [live.servo, live.hsk, phase, captured, s.mode]);

  return (
    <StepShell title="Failsafe" d={d} steps={["failsafe"]}
      intro={pose
        ? <p>RC lost for {p.failsafe.delayMs / 1000} s: throttle closed, full up elevator, right rudder, right aileron, flaps down, spoilers stowed.</p>
        : <p>RC lost: ArduPilot GLIDE (throttle off, wings level).</p>}
      help={pose ? "Released as soon as the link returns. ArduPilot GLIDE is set underneath in case the script stops." : "This board can't run the companion script, so the DBF pose isn't available."} docs={["failsafe"]}>
      <PropsGate>
        <label className="field inline">Link loss → failsafe after
          <input className="num short" type="number" min={500} max={10000} step={100} value={p.failsafe.delayMs}
            onChange={(e) => updateProfile((x) => ({ ...x, failsafe: { ...x.failsafe, delayMs: Number(e.target.value) } }))} /> ms
        </label>
        {pose && !scriptOk && <p className="warn-box">Companion script v{BUNDLED_VERSION} not running. Install it first.</p>}
        {earlier.length > 0 && <p className="warn-box">Apply Sticks and Airframe first. The pose is captured from the current setup.</p>}

        {pose && (
          <div className="card">
            <h3>1. Capture the pose</h3>
            <p className="muted">Records every output in the pose.<Help>Holds the sticks in the pose over USB (disarmed, MANUAL) and reads what each output does, including mixing and reversal.</Help></p>
            <table className="grid compact"><tbody>
              {describePose(p).map(({ s: x, text }) => (
                <tr key={x.id}><td>{x.name}</td><td>S{x.output}</td><td>{text}</td><td className="mono">{captured?.[x.output! - 1] || ""}</td></tr>
              ))}
              {p.motors.filter((m) => m.output).map((m) => <tr key={m.id}><td>{m.name}</td><td>S{m.output}</td><td>throttle closed</td><td className="mono">{captured?.[m.output! - 1] || ""}</td></tr>)}
            </tbody></table>
            <button className={captured ? "" : "primary"} disabled={phase !== "idle" || s.armed || earlier.length > 0} onClick={() => void capture()}>
              {phase === "capturing" ? "Capturing…" : captured ? "Capture again" : "Capture the pose"}
            </button>
            {p.failsafe.capturedAt && <span className="muted"> Captured {new Date(p.failsafe.capturedAt).toLocaleString()}</span>}
          </div>
        )}

        <div className="card">
          <h3>{pose ? "3" : "2"}. Test it</h3>
          <p className="muted">Apply first (bottom), then switch the transmitter off.</p>
          {phase === "idle" || phase === "done" || phase === "fail" ? (
            <button className="primary" disabled={pending.length > 0 || (pose && (!captured || !scriptOk))} onClick={() => setPhase(pose ? "off" : "glide-off")}>
              {st === "ok" ? "Test again" : "Start the test"}
            </button>
          ) : null}
          {(phase === "off" || phase === "glide-off") && (
            <div><div className="big-prompt">Turn the transmitter OFF now.</div>
              <p className="muted">Waiting for the board to go into failsafe{pose ? " and every output to reach its pose" : " (mode → FBWA)"}…</p></div>
          )}
          {phase === "look" && (
            <div>
              <div className="big-prompt">Look at the plane. Does every surface match?</div>
              <ul>{describePose(p).map(({ s: x, text }) => <li key={x.id}><strong>{x.name}</strong>: {text}</li>)}<li><strong>Motor</strong>: off</li></ul>
              <div className="row answers">
                <button className="big" onClick={() => setPhase("on")}>Yes, all match</button>
                <button className="big" onClick={() => { setMsg("A surface is wrong in the pose: re-check that surface's direction, then capture again."); setPhase("fail"); }}>No</button>
              </div>
            </div>
          )}
          {phase === "on" && <div className="big-prompt">Now turn the transmitter back ON. Control should return.</div>}
          {phase === "done" && <p className="ok-box">✓ Failsafe tested{p.failsafe.mode === "pose" ? ": pose on link loss, released when the link came back" : ""}.</p>}
          {msg && <p className="error-box">{msg}</p>}
          {session.isSitl && phase !== "idle" && phase !== "done" && (
            <p className="muted">Simulator: <button className="small" onClick={() => void simulateTx(false)}>transmitter off</button> <button className="small" onClick={() => void simulateTx(true)}>transmitter on</button></p>
          )}
          <p className="muted">Status: {st === "ok" ? "✓ tested with the current settings" : st === "stale" ? "settings changed since the last test" : "not tested"}</p>
        </div>
      </PropsGate>
    </StepShell>
  );
}

// ---------------- Arming ----------------
export function ArmingStep({ p, d }: { p: Profile; d: Derived }) {
  const s = useSession();
  const live = useLive();
  const lastGate = [...s.log].reverse().find((l) => /can't arm|Arm:|PreArm/i.test(l.text));
  const set = (patch: Partial<Profile["arming"]>) => updateProfile((x) => ({ ...x, arming: { ...x.arming, ...patch } }));
  return (
    <StepShell title="Arming" d={d} steps={["arming"]}
      intro={<p>Arm: full right rudder, throttle down, hold 2 s.</p>}
      help="ArduPilot pre-arm checks are off. The companion script blocks arming only for real problems: no RC, settings edited by hand, failsafe pose not set." docs={["arming", "prearm"]}>
      <div className="choices">
        <label className={`choice ${p.arming.method === "rudder-script" ? "on" : ""}`}>
          <input type="radio" checked={p.arming.method === "rudder-script"} disabled={!d.facts.hasScripting} onChange={() => set({ method: "rudder-script" })} />
          <strong>Rudder stick, through the companion script</strong>
          <span>If the script isn't running (no SD card, crashed), the stick can't arm the plane. Recommended.</span>
        </label>
        <label className={`choice ${p.arming.method === "rudder-native" ? "on" : ""}`}>
          <input type="radio" checked={p.arming.method === "rudder-native"} onChange={() => set({ method: "rudder-native" })} />
          <strong>Rudder stick, ArduPilot's own</strong>
          <span>Works without the script, but then nothing stops arming with a missing failsafe.</span>
        </label>
      </div>
      {p.arming.method === "rudder-native" && (
        <label className="field inline"><input type="checkbox" checked={p.arming.rudderDisarm} onChange={(e) => set({ rudderDisarm: e.target.checked })} /> also allow disarming with left rudder (not recommended)</label>
      )}
      <h3>Arming gate right now</h3>
      <p>{live.hsk && Date.now() - live.hsk.t < 4000
        ? live.hsk.state === 0 ? <span className="ok-text">✓ ready to arm</span> : live.hsk.state === 2 ? <span className="warn-text">blocking arming: {lastGate?.text ?? "see messages"}</span> : live.hsk.state === 1 ? <span className="warn-text">in failsafe (no RC)</span> : "script disabled"
        : <span className="muted">companion script not running</span>}</p>
      <p className="muted">Board is {s.armed ? "ARMED" : "disarmed"} in {MODE_NAMES[s.mode] ?? `mode ${s.mode}`}.</p>
    </StepShell>
  );
}

// ---------------- Finish ----------------
const ALL: StepId[] = ["receiver", "sticks", "modes", "outputs", "motor", "directions", "trims", "failsafe", "arming", "pinned"];

export function FinishStep({ p, d }: { p: Profile; d: Derived }) {
  const meta = useMetadata();
  const [reviewing, setReviewing] = useState(false);
  const diff = diffCompiled(d.compiled, d.board, ALL);
  const checks = [
    ...p.surfaces.filter((s) => s.output && s.kind !== "fixed").map((s) => ({ id: `direction:${s.id}`, label: `${s.name} direction` })),
    { id: "stabilize", label: "Stabilization (FBWA) direction" },
    { id: "failsafe", label: "Failsafe test" },
  ];
  const errors = d.findings.filter((f) => f.severity === "error");
  if (reviewing) return <Review items={diff} meta={meta} title="Apply the whole profile" onCancel={() => setReviewing(false)} onDone={() => setReviewing(false)} />;
  return (
    <div className="step">
      <h1>Finish</h1>
      <h3>Everything the rules found</h3>
      {d.findings.length ? <Findings findings={d.findings} /> : <p className="ok-box">✓ No problems.</p>}
      <h3>Physical checks</h3>
      <table className="grid compact"><tbody>{checks.map((c) => {
        const st = check(c.id, p);
        return <tr key={c.id}><td>{c.label}</td><td>{st === "ok" ? <span className="ok-text">✓ done</span> : st === "stale" ? <span className="warn-text">settings changed since: redo</span> : <span className="error-text">not done</span>}</td></tr>;
      })}</tbody></table>
      <h3>Board vs profile</h3>
      {diff.length === 0 ? <p className="ok-box">✓ The board matches the profile.</p> : (
        <p><button className="primary" onClick={() => setReviewing(true)}>Review and apply {diff.length} remaining change{diff.length === 1 ? "" : "s"}</button></p>
      )}
      {d.compiled.absent.length > 0 && <p className="muted">Not on the board yet: {d.compiled.absent.join(", ")}</p>}
      <div className="row">
        <button onClick={() => downloadJson(`${p.name.replace(/[^\w.-]+/g, "_")}.json`, p)}>Save profile file</button>
        {errors.length > 0 && <span className="error-text">{errors.length} thing{errors.length === 1 ? "" : "s"} must be fixed before this plane is ready.</span>}
      </div>
      <div className="card">
        <h3>Not in the wizard yet</h3>
        <p className="muted">Use Mission Planner for: orientation, accel calibration, compass, GPS, airspeed, battery, logging, firmware.</p>
      </div>
    </div>
  );
}

