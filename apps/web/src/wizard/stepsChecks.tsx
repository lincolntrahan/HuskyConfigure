import { useEffect, useRef, useState } from "react";
import { diffCompiled, isUpright, mixInputs, rcOf, type MixTerm, type Profile, type Surface } from "@husky/profile";
import { session, useSession, PLANE_MODES } from "../state.ts";
import { Bar, PropsGate, StepShell, useLive } from "./common.tsx";
import { boardMap, check, passCheck, updateProfile, type Derived } from "./store.ts";

const sgn = (x: number) => (x < 0 ? -1 : 1);

/** Which way to move an input so a term is active, and how to say it. */
export function inputPrompt(t: MixTerm, p: Profile): { x: number; text: string } {
  const x = t.curve === "positive" ? sgn(t.w) : t.curve === "negative" ? -sgn(t.w) : 1;
  const custom = p.inputs.find((i) => i.id === t.in);
  switch (t.in) {
    case "roll": return { x, text: `Move the ROLL stick fully ${x > 0 ? "RIGHT" : "LEFT"} and hold it` };
    case "pitch": return { x, text: x > 0 ? "Pull the PITCH stick fully BACK (toward you) and hold it" : "Push the PITCH stick fully FORWARD and hold it" };
    case "yaw": return { x, text: `Move the RUDDER stick fully ${x > 0 ? "RIGHT" : "LEFT"} and hold it` };
    case "flap": return { x: 1, text: "Set the FLAP control to full flaps" };
    case "throttle": return { x: 1, text: "Push the THROTTLE up" };
  }
  if (custom) return { x: custom.range === "unipolar" ? 1 : x, text: custom.range === "unipolar" ? `Set ${custom.label} fully ON` : `Move ${custom.label} fully ${x > 0 ? "up" : "down"}` };
  return { x, text: `Move RC channel ${rcOf(t.in, p)} fully ${x > 0 ? "high" : "low"}` };
}

/** SITL only: which RC channel/PWM simulates an input pushed to x. */
function simulatedStick(t: MixTerm, x: number, p: Profile): [number, number] | undefined {
  const b = boardMap();
  const ch = t.in === "roll" ? p.rc.roll : t.in === "pitch" ? p.rc.pitch : t.in === "yaw" ? p.rc.yaw : t.in === "throttle" ? p.rc.throttle : t.in === "flap" ? p.flapChannel : rcOf(t.in, p);
  if (!ch) return undefined;
  const rev = b.get(`RC${ch}_REVERSED`) === 1;
  const hi = (x > 0) !== rev;
  return [ch, hi ? b.get(`RC${ch}_MAX`) ?? 1900 : b.get(`RC${ch}_MIN`) ?? 1100];
}

// ---------------- Directions ----------------
interface Run { id: string; term: number; base?: number; moved: boolean; problem?: string; fixSide?: number }

export function DirectionsStep({ p, d }: { p: Profile; d: Derived }) {
  const s = useSession();
  const live = useLive();
  const [run, setRun] = useState<Run>();
  const pending = diffCompiled(d.compiled, d.board, ["outputs", "sticks"]);
  const testable = p.surfaces.filter((x) => x.output && x.kind !== "fixed" && mixInputs(x).some((i) => i !== "throttle"));

  const surf = run && p.surfaces.find((x) => x.id === run.id);
  const terms = surf ? surf.mix.filter((t) => t.w !== 0 && t.in !== "throttle") : [];
  const term = run ? terms[run.term] : undefined;

  // movement detection on the output under test
  useEffect(() => {
    if (!run || !surf?.output || run.problem) return;
    const v = live.servo[surf.output - 1];
    if (!v) return;
    if (run.base === undefined) { setRun({ ...run, base: v }); return; }
    if (!run.moved && Math.abs(v - run.base) > 30) setRun({ ...run, moved: true });
  }, [live.servo, run, surf]);

  async function start(x: Surface) {
    if (s.mode !== 0) await session.setMode(0);
    setRun({ id: x.id, term: 0, moved: false });
  }
  async function answer(dir: number | "none") {
    if (!run || !surf || !term) return;
    await session.stopOverride();
    if (dir === "none") { setRun({ ...run, problem: "none" }); return; }
    const want = sgn(term.w * inputPrompt(term, p).x);
    if (dir === want) {
      if (run.term + 1 < terms.length) setRun({ id: run.id, term: run.term + 1, moved: false });
      else { passCheck(`direction:${run.id}`); setRun(undefined); }
      return;
    }
    if (run.term === 0) {
      // first input backwards: the servo is reversed. Flip it and test again.
      const n = surf.output!;
      const rev = d.board.get(`SERVO${n}_REVERSED`) === 1 ? 0 : 1;
      const r = await session.write([{ name: `SERVO${n}_REVERSED`, value: rev }], `Reverse ${surf.name}`);
      if (!r.ok) { setRun({ ...run, problem: r.aborted ?? "couldn't change the reversal" }); return; }
      updateProfile((x) => ({ ...x, surfaces: x.surfaces.map((y) => (y.id === surf.id ? { ...y, reversed: rev === 1 } : y)) }));
      setRun({ id: run.id, term: 0, moved: false });
    } else {
      setRun({ ...run, problem: "side", fixSide: run.term });
    }
  }
  function fixSide() {
    if (!run || !surf || run.fixSide === undefined) return;
    const t = terms[run.fixSide]!;
    updateProfile((x) => ({ ...x, surfaces: x.surfaces.map((y) => (y.id === surf.id ? { ...y, mix: y.mix.map((m) => (m === t || (m.in === t.in && m.w === t.w) ? { ...m, w: -m.w } : m)) } : y)) }));
    setRun(undefined);
  }

  const prompt = term ? inputPrompt(term, p) : undefined;
  const sim = term && prompt && session.isSitl ? simulatedStick(term, prompt.x, p) : undefined;
  const vertical = surf ? isUpright(surf) : false;

  return (
    <StepShell title="Surface directions" d={d}
      intro={<p>For each surface, move one stick at a time and say which way the surface went. The board is in MANUAL and disarmed, so the motor stays off. Wrong directions get fixed on the spot.</p>}>
      <PropsGate>
        {pending.length > 0 && <p className="warn-box">Apply the Sticks and Airframe-and-outputs steps first ({pending.length} setting{pending.length === 1 ? "" : "s"} differ{pending.length === 1 ? "s" : ""} from the board). Testing now would test the old setup.</p>}
        {surf && term && prompt ? (
          <div className="card test">
            <h2>{surf.name} <span className="muted">S{surf.output} · input {run!.term + 1} of {terms.length}</span></h2>
            {run!.problem === "side" ? (
              <>
                <p className="error-box">{surf.name} moved the right way for the first input but backwards for this one. That usually means it's set up as the wrong side (left vs right).</p>
                <button className="primary" onClick={fixSide}>Fix the mix</button> <span className="muted">Then apply the Outputs step again and re-test.</span>
              </>
            ) : run!.problem === "none" ? (
              <>
                <p className="error-box">Nothing moved. Check the servo is plugged into S{surf.output} (signal wire the right way round), the flight battery is connected, and the transmitter is on.</p>
                <button onClick={() => setRun({ id: run!.id, term: run!.term, moved: false })}>Try again</button>
              </>
            ) : run!.problem ? <p className="error-box">{run!.problem}</p> : (
              <>
                <div className="big-prompt">{prompt.text}.</div>
                <p>Then watch <strong>{surf.name}</strong>. Which way did its trailing edge move?</p>
                <div className="row">
                  <Bar value={live.servo[surf.output! - 1] ?? 0} mark={run!.base} />
                  <span className="mono">{live.servo[surf.output! - 1]} µs</span>
                  {!run!.moved && <span className="muted">waiting for it to move…</span>}
                </div>
                <div className="row answers">
                  <button className="big" disabled={!run!.moved} onClick={() => void answer(1)}>{vertical ? "RIGHT" : "UP"}</button>
                  <button className="big" disabled={!run!.moved} onClick={() => void answer(-1)}>{vertical ? "LEFT" : "DOWN"}</button>
                  <button onClick={() => void answer("none")}>It didn't move</button>
                </div>
                {sim && <p className="muted">Simulator: <button className="small" onClick={() => session.startOverride({ [sim[0]]: sim[1] })}>simulate this stick</button></p>}
              </>
            )}
            <button className="link" onClick={() => { void session.stopOverride(); setRun(undefined); }}>Stop testing</button>
          </div>
        ) : null}
        <table className="grid">
          <thead><tr><th>Surface</th><th>Output</th><th>Inputs</th><th>Status</th><th></th></tr></thead>
          <tbody>{testable.map((x) => {
            const st = check(`direction:${x.id}`, p);
            return (
              <tr key={x.id}>
                <td><strong>{x.name}</strong></td><td>S{x.output}{d.board.get(`SERVO${x.output}_REVERSED`) ? " (reversed)" : ""}</td>
                <td>{mixInputs(x).filter((i) => i !== "throttle").join(", ")}</td>
                <td>{st === "ok" ? <span className="ok-text">✓ checked</span> : st === "stale" ? <span className="warn-text">needs re-check (settings changed)</span> : <span className="muted">not checked</span>}</td>
                <td><button className="small" disabled={!!run || pending.length > 0 || s.armed} onClick={() => void start(x)}>{st === "ok" ? "Re-test" : "Test"}</button></td>
              </tr>
            );
          })}</tbody>
        </table>
        {testable.length === 0 && <p className="muted">No surfaces plugged into outputs yet (Airframe and outputs step).</p>}
      </PropsGate>
    </StepShell>
  );
}

// ---------------- Stabilization ----------------
type StabPhase = "idle" | "roll" | "roll-ask" | "pitch" | "pitch-ask" | "fail";

export function StabilizeStep({ p, d }: { p: Profile; d: Derived }) {
  const s = useSession();
  const live = useLive();
  const [phase, setPhase] = useState<StabPhase>("idle");
  const [why, setWhy] = useState<string>();
  const deg = (r?: number) => Math.round(((r ?? 0) * 180) / Math.PI);
  const st = check("stabilize", p);
  const prevMode = useRef(0);

  useEffect(() => {
    if (phase === "roll" && deg(live.attitude?.roll) > 20) setPhase("roll-ask");
    if (phase === "pitch" && deg(live.attitude?.pitch) > 20) setPhase("pitch-ask");
  }, [live.attitude, phase]);

  async function begin() {
    prevMode.current = s.mode;
    if (!(await session.setMode(5))) { setWhy("The board refused to switch to FBWA."); setPhase("fail"); return; }
    setPhase("roll");
  }
  async function end(ok: boolean, reason?: string) {
    await session.setMode(0);
    if (ok) { passCheck("stabilize"); setPhase("idle"); } else { setWhy(reason); setPhase("fail"); }
  }
  const allowed = p.modes.slots.includes(5) || p.modes.slots.includes(4);

  return (
    <StepShell title="Stabilization check" d={d}
      intro={<p>This protects you if someone flips the mode switch by accident, and the GLIDE failsafe relies on it too. In FBWA the board pushes the surfaces to level the plane. Here you tilt the plane by hand and check the surfaces push back the right way.</p>}>
      <PropsGate>
        {!allowed && <p className="muted">FBWA/ACRO aren't on the mode switch, but GLIDE failsafe still uses FBWA, so do this check anyway.</p>}
        <p>Status: {st === "ok" ? <span className="ok-text">✓ checked</span> : st === "stale" ? <span className="warn-text">needs re-check</span> : <span className="muted">not checked</span>}
          <span className="muted"> · board now in {PLANE_MODES[s.mode] ?? s.mode}, roll {deg(live.attitude?.roll)}°, pitch {deg(live.attitude?.pitch)}°</span></p>
        {phase === "idle" && <button className="primary" disabled={s.armed} onClick={() => void begin()}>Start (switches to FBWA, motor stays off)</button>}
        {phase === "roll" && <div className="big-prompt">Hold the plane level, then tilt it so the RIGHT wing goes DOWN about 30° and hold it there.</div>}
        {phase === "roll-ask" && (
          <div>
            <div className="big-prompt">Right wing down: did the ailerons move to lift it back up? (right aileron DOWN, left aileron UP)</div>
            <div className="row answers"><button className="big" onClick={() => setPhase("pitch")}>Yes</button><button className="big" onClick={() => void end(false, "Roll stabilization goes the wrong way.")}>No</button></div>
          </div>
        )}
        {phase === "pitch" && <div className="big-prompt">Now level the wings and lift the NOSE up about 30°. Hold it there.</div>}
        {phase === "pitch-ask" && (
          <div>
            <div className="big-prompt">Nose up: did the elevator (or ruddervators / elevons) move DOWN to push the nose back down?</div>
            <div className="row answers"><button className="big" onClick={() => void end(true)}>Yes</button><button className="big" onClick={() => void end(false, "Pitch stabilization goes the wrong way.")}>No</button></div>
          </div>
        )}
        {phase === "fail" && (
          <div className="error-box">
            <strong>{why}</strong>
            <p>If the MANUAL direction check passed, the board's mounting orientation is almost certainly wrong (AHRS_ORIENTATION). Don't fly in FBWA until this passes. The board is back in MANUAL.</p>
            <button onClick={() => setPhase("idle")}>Try again</button>
          </div>
        )}
        {phase !== "idle" && phase !== "fail" && <button className="link" onClick={() => void end(false, "Stopped.")}>Stop</button>}
        {session.isSitl && phase !== "idle" && <p className="muted">The simulator can't be tilted by hand; this step needs a real board.</p>}
      </PropsGate>
    </StepShell>
  );
}
