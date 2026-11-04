/**
 * Board orientation and accelerometers: how the flight controller is mounted (AHRS_ORIENTATION),
 * a tilt check that proves it, the 6-position accelerometer calibration and level.
 * Order matters: the calibration positions are read through the orientation, so the mounting
 * is set (and the board rebooted) first.
 */
import { useEffect, useState } from "react";
import { diffCompiled, type Profile } from "@husky/profile";
import { session, useMetadata, useSession } from "../state.ts";
import { StepShell, useLive } from "./common.tsx";
import { check, passCheck, updateProfile, type Derived } from "./store.ts";
import { Help } from "../components/Help.tsx";

type Arrow = "forward" | "right" | "back" | "left";
const ARROWS: { a: Arrow; glyph: string; deg: number }[] = [
  { a: "forward", glyph: "↑", deg: 0 }, { a: "right", glyph: "→", deg: 90 }, { a: "back", glyph: "↓", deg: 180 }, { a: "left", glyph: "←", deg: 270 },
];
/** ArduPilot rotations for a flat board: [right side up, upside down] per arrow direction. */
const FLAT: Record<Arrow, [number, number]> = { forward: [0, 8], right: [2, 10], back: [4, 12], left: [6, 14] };
function fromRotation(r: number): { arrow: Arrow; flipped: boolean } | undefined {
  for (const [a, [up, down]] of Object.entries(FLAT) as [Arrow, [number, number]][]) {
    if (r === up) return { arrow: a, flipped: false };
    if (r === down) return { arrow: a, flipped: true };
  }
  return undefined;
}

/** ACCELCAL_VEHICLE_POS 1..6: what to tell the person holding the plane. */
const POSITIONS: Record<number, { name: string; how: string }> = {
  1: { name: "Level", how: "Plane flat and level on the table, right side up." },
  2: { name: "Left side down", how: "Stand the plane on its LEFT wingtip, wings vertical." },
  3: { name: "Right side down", how: "Stand the plane on its RIGHT wingtip, wings vertical." },
  4: { name: "Nose down", how: "Point the nose straight DOWN, fuselage vertical." },
  5: { name: "Nose up", how: "Point the nose straight UP, fuselage vertical." },
  6: { name: "Upside down", how: "Flip the plane onto its back, flat and level." },
};

const deg = (r?: number) => Math.round(((r ?? 0) * 180) / Math.PI);

export function SensorsStep({ p, d }: { p: Profile; d: Derived }) {
  const s = useSession();
  const meta = useMetadata();
  const board = d.board.get("AHRS_ORIENTATION");
  const want = p.orientation ?? board ?? 0;
  const flat = fromRotation(want);
  const pending = diffCompiled(d.compiled, d.board, ["orientation"]).length > 0;
  const needsReboot = s.rebootNeeded.includes("AHRS_ORIENTATION");
  const ready = !pending && !needsReboot;
  const setRot = (r: number) => updateProfile((x) => ({ ...x, orientation: r }));
  const names = meta?.set.params.AHRS_ORIENTATION?.v ?? {};

  return (
    <StepShell title="Orientation and accelerometers" d={d} steps={["orientation"]}
      intro={<p>Tell the board how it is mounted, check it, then calibrate.</p>}
      help="ArduPilot needs to know which way the board faces to stabilize the plane. Calibrate after the mounting is set: the positions are read through it." docs={["mounting", "accelCal"]}>
      <div className="sens-grid">
        <div className="card">
          <h3>1. Mounting</h3>
          <div className="mount">
            <BoardPicture arrow={flat?.arrow} flipped={flat?.flipped} />
            <div className="mount-pick">
              <span className="muted">Arrow on the board points</span>
              <div className="seg arrows">
                {ARROWS.map(({ a, glyph }) => (
                  <button key={a} className={flat?.arrow === a ? "on" : ""} onClick={() => setRot(FLAT[a][flat?.flipped ? 1 : 0])}>{glyph} {a}</button>
                ))}
              </div>
              <span className="muted">Board is</span>
              <div className="seg">
                <button className={flat && !flat.flipped ? "on" : ""} onClick={() => setRot(FLAT[flat?.arrow ?? "forward"][0])}>right side up</button>
                <button className={flat?.flipped ? "on" : ""} onClick={() => setRot(FLAT[flat?.arrow ?? "forward"][1])}>upside down</button>
              </div>
              <details className="adv" open={!flat}>
                <summary>Other mounting (on its side, 45°…)</summary>
                <select value={want} onChange={(e) => setRot(Number(e.target.value))}>
                  {Object.entries(names).map(([v, l]) => <option key={v} value={v}>{l} ({v})</option>)}
                </select>
              </details>
              <p className="muted">AHRS_ORIENTATION = {names[String(want)] ?? want} ({want}){board !== undefined && board !== want ? ` · board has ${names[String(board)] ?? board}` : ""}</p>
            </div>
          </div>
          {pending && <p className="warn-box">Not on the board yet: use Review and apply below, then reboot.</p>}
          {!pending && needsReboot && (
            <div className="warn-box row tight">Orientation takes effect after a reboot.
              <button className="primary small" disabled={!!s.busy || s.armed} onClick={() => void session.rebootAndReconnect("Rebooting for the new orientation")}>Reboot now</button></div>
          )}
        </div>

        <TiltCheck p={p} ready={ready} />
        <AccelCal p={p} ready={ready} />
        <Level p={p} ready={ready} />
      </div>
    </StepShell>
  );
}

/** Top view of the plane with the board on it and its arrow. */
function BoardPicture({ arrow, flipped }: { arrow?: Arrow; flipped?: boolean }) {
  const rot = ARROWS.find((x) => x.a === arrow)?.deg;
  return (
    <svg className="mount-pic" viewBox="0 -16 160 212" role="img" aria-label="Board on the plane, top view">
      <path className="af-sil" d="M80 6 L90 30 L90 70 L155 92 L155 104 L90 100 L88 150 L112 162 L112 170 L80 166 L48 170 L48 162 L72 150 L70 100 L5 104 L5 92 L70 70 L70 30 Z" />
      <text x="80" y="-4" textAnchor="middle" className="af-hint">NOSE</text>
      <rect x="55" y="62" width="50" height="50" className={`mount-board ${flipped ? "flipped" : ""}`} />
      {rot !== undefined && (
        <g transform={`rotate(${rot} 80 87)`}>
          <path d="M80 68 L92 84 L84 84 L84 104 L76 104 L76 84 L68 84 Z" className="mount-arrow" />
        </g>
      )}
      {flipped && <text x="80" y="190" textAnchor="middle" className="af-hint">BOARD UPSIDE DOWN</text>}
    </svg>
  );
}

/** Lift the nose and drop the right wing: pitch and roll must read the right way. */
function TiltCheck({ p, ready }: { p: Profile; ready: boolean }) {
  const live = useLive();
  const [stage, setStage] = useState<"idle" | "nose" | "wing" | "fail">("idle");
  const [why, setWhy] = useState("");
  const pitch = deg(live.attitude?.pitch);
  const roll = deg(live.attitude?.roll);
  const st = check("orientation", p);

  useEffect(() => {
    if (stage === "nose") {
      if (pitch > 20) setStage("wing");
      else if (pitch < -20) { setWhy("Nose up made pitch go DOWN."); setStage("fail"); }
      else if (Math.abs(roll) > 30) { setWhy("Nose up made the board think it rolled: the arrow direction is off by 90°."); setStage("fail"); }
    }
    if (stage === "wing") {
      if (roll > 20) { passCheck("orientation"); setStage("idle"); }
      else if (roll < -20) { setWhy("Right wing down made roll go LEFT."); setStage("fail"); }
      else if (Math.abs(pitch) > 30 && Math.abs(roll) < 10) { setWhy("Rolling made the board think the nose moved: the arrow direction is off by 90°."); setStage("fail"); }
    }
  }, [pitch, roll, stage]);

  return (
    <div className="card">
      <h3>2. Check it <Help>Proves the mounting before anything else depends on it. Tilt by hand, no props, board on USB.</Help></h3>
      <div className="tilt-read mono">
        <span>PITCH <b>{pitch > 0 ? "+" : ""}{pitch}°</b></span><span>ROLL <b>{roll > 0 ? "+" : ""}{roll}°</b></span>
      </div>
      <p>Status: {st === "ok" ? <span className="ok-text">✓ checked</span> : st === "stale" ? <span className="warn-text">mounting changed, check again</span> : <span className="muted">not checked</span>}</p>
      {!ready && <p className="muted">Apply the mounting and reboot first.</p>}
      {stage === "idle" && <button className="primary" disabled={!ready} onClick={() => setStage("nose")}>Start check</button>}
      {stage === "nose" && <div className="big-prompt">Hold the plane level, then lift the NOSE up about 30°.</div>}
      {stage === "wing" && <div className="big-prompt">✓ Nose up reads right. Level it, then drop the RIGHT wing about 30°.</div>}
      {stage === "fail" && (
        <div className="error-box">{why} The mounting setting is wrong for how the board sits.
          <div className="row tight"><button onClick={() => setStage("idle")}>Try again</button></div></div>
      )}
      {(stage === "nose" || stage === "wing") && <button className="link" onClick={() => setStage("idle")}>Stop</button>}
      {session.isSitl && <p className="muted">The simulator can't be tilted: this check needs a real board.</p>}
    </div>
  );
}

function AccelCal({ p, ready }: { p: Profile; ready: boolean }) {
  const s = useSession();
  const c = s.accelCal;
  const st = check("accelcal", p);
  const b = session.params;
  const raw = (n: string) => b.get(n)?.value;
  const neverDone = ["X", "Y", "Z"].every((a) => (raw(`INS_ACCOFFS_${a}`) ?? 0) === 0 && (raw(`INS_ACCSCAL_${a}`) ?? 1) === 1);
  const running = c && (c.state === "starting" || c.state === "waiting" || c.state === "sampling");

  useEffect(() => { if (c?.state === "done") passCheck("accelcal"); }, [c?.state]);
  useEffect(() => {
    if (c?.state !== "waiting") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void session.accelCalInPlace(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c?.state]);

  async function start() {
    try { await session.startAccelCal(); } catch (e) { alert((e as Error).message); }
  }
  const pos = c?.pos ? POSITIONS[c.pos] : undefined;
  return (
    <div className="card">
      <h3>3. Accelerometers <Help docs={["accelCal"]}>Six positions, held still for a few seconds each. Done once per board; redo after a crash or a new board. ArduPilot's own "not calibrated" warning is off in this setup, so don't skip it.</Help></h3>
      <p>Status: {c?.state === "done" || st === "ok" ? <span className="ok-text">✓ calibrated</span>
        : neverDone ? <span className="bad-text">never calibrated on this board</span>
        : st === "stale" ? <span className="warn-text">changed since the tool calibrated it</span>
        : <span className="muted">calibrated before (not by this tool)</span>}</p>
      {!running && <button className="primary" disabled={!ready || !session.canWrite || !!s.busy} onClick={() => void start()}>Calibrate accelerometers</button>}
      {!ready && !running && <p className="muted">Apply the mounting and reboot first.</p>}
      {running && (
        <>
          <div className="cal-steps">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <span key={n} className={`cal-dot ${n < (c.pos || 0) ? "done" : n === c.pos ? "now" : ""}`}>{n}. {POSITIONS[n]!.name}</span>
            ))}
          </div>
          {c.state === "starting" && <div className="big-prompt">Starting…</div>}
          {c.state === "waiting" && pos && (
            <div className="big-prompt">{c.pos}/6 · {pos.name}: {pos.how}
              <div className="row tight"><button className="primary" onClick={() => void session.accelCalInPlace()}>In position (Enter)</button></div></div>
          )}
          {c.state === "sampling" && pos && <div className="big-prompt">Hold still… reading {pos.name.toLowerCase()}.</div>}
          <button className="link" onClick={() => void session.cancelAccelCal(true)}>Cancel (reboots the board)</button>
        </>
      )}
      {c?.state === "done" && <p className="ok-box">Calibration saved on the board.</p>}
      {c?.state === "failed" && (
        <div className="error-box">{c.message ?? "Calibration failed."} Until the board reboots it has NO accelerometer calibration; a reboot brings the old one back.
          <div className="row tight">
            <button className="primary" disabled={!!s.busy} onClick={() => void session.cancelAccelCal(true)}>Reboot (restores the old calibration)</button>
            <button disabled={!!s.busy} onClick={() => void session.cancelAccelCal(false).then(start)}>Try again</button>
          </div></div>
      )}
      {session.isSitl && <p className="muted">The simulator can't be turned over, so it fails at the end.</p>}
    </div>
  );
}

function Level({ p, ready }: { p: Profile; ready: boolean }) {
  const s = useSession();
  const live = useLive();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const st = check("level", p);
  async function go() {
    setMsg(undefined);
    try {
      const r = await session.calibrateLevel();
      if (r === 0) { passCheck("level"); setMsg({ ok: true, text: "Level saved." }); }
      else setMsg({ ok: false, text: `The board refused (result ${r}). Keep it still and try again.` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  return (
    <div className="card">
      <h3>4. Level <Help>Sets what "wings level" means to FBWA. Do it after the accelerometers, and again if the board is re-mounted.</Help></h3>
      <p>Status: {st === "ok" ? <span className="ok-text">✓ set</span> : st === "stale" ? <span className="warn-text">mounting changed, set again</span> : <span className="muted">not set by this tool</span>}</p>
      <p>Prop the plane at its normal flying attitude, wings level, and keep it still.</p>
      <p className="muted mono">Board now: pitch {deg(live.attitude?.pitch)}°, roll {deg(live.attitude?.roll)}°</p>
      <button className="primary" disabled={!ready || !session.canWrite || !!s.busy || (!!s.accelCal && s.accelCal.state !== "done")} onClick={() => void go()}>Set level</button>
      {msg && <p className={msg.ok ? "ok-box" : "error-box"}>{msg.text}</p>}
    </div>
  );
}
