import { useEffect, useRef, useState } from "react";
import { emptyProfile, inferProfile, MODE_NAMES, type Profile } from "@husky/profile";
import { session, useSession } from "../state.ts";
import { Bar, RcBars, StepShell, useLive } from "./common.tsx";
import { boardFacts, boardMap, downloadJson, setProfile, updateProfile, type Derived } from "./store.ts";

// ---------------- Start ----------------
export function StartStep({ p, d }: { p: Profile | null; d: Derived | null }) {
  const s = useSession();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string>();
  const bind = (x: Profile): Profile => ({ ...x, board: { target: s.info?.target, uid: s.info?.uid, firmware: s.info?.firmware } });

  async function open(f: File) {
    try {
      const x = JSON.parse(await f.text()) as Profile;
      if (x.schema !== 1 || !Array.isArray(x.surfaces)) throw new Error("not a HuskyConfigure profile");
      const sameBoard = x.board?.uid === s.info?.uid;
      setProfile(bind(sameBoard ? x : { ...x, verifications: {} }));
      setErr(sameBoard ? undefined : "This profile was set up on a different flight controller, so every physical check has to be done again on this one.");
    } catch (e) { setErr(`Couldn't open ${f.name}: ${(e as Error).message}`); }
  }

  if (!p) {
    const facts = boardFacts();
    return (
      <div className="step">
        <h1>Set up an aircraft</h1>
        <p className="intro">The wizard describes the airplane (surfaces, mixes, which pad each servo is plugged into), works out the parameters, and walks you through checking every surface by eye. Nothing is written without a review.</p>
        <label className="field">Aircraft name <input value={name} placeholder="e.g. Mako V3 SN-1" onChange={(e) => setName(e.target.value)} /></label>
        <div className="choices">
          <button className="choice" onClick={() => setProfile(bind(inferProfile(boardMap(), { name: name || "Imported from board", outputs: facts.outputs, hasScripting: facts.hasScripting })))}>
            <strong>Start from what's on this board</strong>
            <span>Reads the board's current outputs, sticks and modes. Applying it unchanged writes nothing to outputs; the wizard then fixes what's unsafe.</span>
          </button>
          <button className="choice" onClick={() => {
            const x = emptyProfile(name || "New aircraft");
            x.failsafe.mode = facts.hasScripting ? "pose" : "glide";
            x.arming.method = facts.hasScripting ? "rudder-script" : "rudder-native";
            setProfile(bind(x));
          }}>
            <strong>Start fresh</strong>
            <span>Pick an airframe template next.</span>
          </button>
          <label className="choice">
            <strong>Open a profile file…</strong>
            <span>A profile saved from this tool (e.g. from the team repo).</span>
            <input type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void open(f); e.target.value = ""; }} />
          </label>
        </div>
        {err && <p className="error-box">{err}</p>}
      </div>
    );
  }

  const other = p.board?.uid && p.board.uid !== s.info?.uid;
  return (
    <div className="step">
      <h1>{p.name}</h1>
      <label className="field">Aircraft name <input value={p.name} onChange={(e) => updateProfile((x) => ({ ...x, name: e.target.value }))} /></label>
      <label className="field">Notes <textarea rows={3} value={p.notes ?? ""} onChange={(e) => updateProfile((x) => ({ ...x, notes: e.target.value }))} /></label>
      {other && <p className="warn-box">This profile is bound to a different flight controller. Physical checks done there don't count here.</p>}
      {err && <p className="warn-box">{err}</p>}
      <p className="muted">The profile is kept in this browser for this board. Save it to a file to commit it to the team repo.</p>
      <div className="row">
        <button className="primary" onClick={() => downloadJson(`${p.name.replace(/[^\w.-]+/g, "_")}.json`, p)}>Save profile file</button>
        <label className="file-btn">Open a different profile…<input type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void open(f); e.target.value = ""; }} /></label>
        <button onClick={() => { if (confirm("Discard this profile and start over? The board isn't changed.")) setProfile(null); }}>Start over</button>
      </div>
      {d && <p className="muted">{d.compiled.notes.join(" ")}</p>}
    </div>
  );
}

// ---------------- Sticks ----------------
type StickKey = "roll" | "pitch" | "throttle" | "yaw";
const STICK_PROMPTS: { key: StickKey; text: string }[] = [
  { key: "roll", text: "Move the ROLL (aileron) stick fully RIGHT and hold it." },
  { key: "pitch", text: "Pull the PITCH (elevator) stick fully BACK, toward you, and hold it." },
  { key: "throttle", text: "Push the THROTTLE stick fully UP and hold it." },
  { key: "yaw", text: "Move the RUDDER stick fully RIGHT and hold it." },
];

export function SticksStep({ p, d }: { p: Profile; d: Derived }) {
  const live = useLive();
  const [mode, setMode] = useState<"idle" | "map" | "range">("idle");
  const [i, setI] = useState(0);
  const [found, setFound] = useState<Partial<Record<StickKey, { ch: number; rev: boolean }>>>({});
  const [waitRelease, setWaitRelease] = useState(false);
  const base = useRef<number[]>([]);
  const held = useRef<{ ch: number; since: number } | undefined>(undefined);
  const range = useRef<Record<number, { min: number; max: number }>>({});
  const [, tick] = useState(0);

  // mapping: find the channel that moved furthest from where it was when the prompt appeared
  useEffect(() => {
    if (mode !== "map") return;
    const rc = live.rc.slice(0, 8);
    if (!base.current.length) { base.current = rc; return; }
    if (waitRelease) {
      if (rc.every((v, k) => Math.abs(v - (base.current[k] ?? v)) < 120)) { setWaitRelease(false); held.current = undefined; }
      return;
    }
    let best = -1, dv = 0;
    rc.forEach((v, k) => { const x = v - (base.current[k] ?? v); if (Math.abs(x) > Math.abs(dv)) { dv = x; best = k; } });
    if (Math.abs(dv) < 300) { held.current = undefined; return; }
    const now = Date.now();
    if (!held.current || held.current.ch !== best) { held.current = { ch: best, since: now }; return; }
    if (now - held.current.since < 700) return;
    const key = STICK_PROMPTS[i]!.key;
    setFound((f) => ({ ...f, [key]: { ch: best + 1, rev: dv < 0 } }));
    setWaitRelease(true);
    if (i + 1 < STICK_PROMPTS.length) setI(i + 1); else setMode("idle");
  }, [live.rc, mode, i, waitRelease]);

  // ranges: track extremes
  useEffect(() => {
    if (mode !== "range") return;
    for (const ch of [p.rc.roll, p.rc.pitch, p.rc.throttle, p.rc.yaw]) {
      const v = live.rc[ch - 1];
      if (!v) continue;
      const r = range.current[ch] ?? { min: v, max: v };
      range.current[ch] = { min: Math.min(r.min, v), max: Math.max(r.max, v) };
    }
    tick((x) => x + 1);
  }, [live.rc, mode, p.rc]);

  const allFound = STICK_PROMPTS.every((s) => found[s.key]);
  function useMapping() {
    updateProfile((x) => {
      const rc = { ...x.rc, reversed: { ...x.rc.reversed } };
      for (const s of STICK_PROMPTS) { const f = found[s.key]!; rc[s.key] = f.ch; rc.reversed[f.ch] = f.rev; }
      return { ...x, rc };
    });
    setFound({});
  }
  function finishRanges() {
    const chans = [p.rc.roll, p.rc.pitch, p.rc.throttle, p.rc.yaw];
    const bad = chans.filter((c) => { const r = range.current[c]; return !r || r.max - r.min < 500; });
    if (bad.length) { alert(`Channel${bad.length > 1 ? "s" : ""} ${bad.join(", ")} didn't move through a full range. Move every stick to every corner, then try again.`); return; }
    updateProfile((x) => {
      const ranges = { ...x.rc.ranges };
      for (const c of chans) {
        const r = range.current[c]!;
        const now = live.rc[c - 1]!;
        // throttle trim = its low end; others = where the stick rests now (centered)
        const isThr = c === x.rc.throttle;
        ranges[c] = { min: r.min, max: r.max, trim: isThr ? (x.rc.reversed[c] ? r.max : r.min) : now };
      }
      return { ...x, rc: { ...x.rc, ranges } };
    });
    setMode("idle");
  }

  const chans: [StickKey, number][] = [["roll", p.rc.roll], ["pitch", p.rc.pitch], ["throttle", p.rc.throttle], ["yaw", p.rc.yaw]];
  return (
    <StepShell title="Sticks" d={d} steps={["sticks"]}
      intro={<p>Two parts: which channel each stick is on (and which way is which), then the full travel of each stick. Use the transmitter normally; no menus.</p>}>
      <div className="two-col">
        <div>
          <h3>1. Which stick is which</h3>
          {mode === "map" ? (
            <div className="prompt">
              <div className="big-prompt">{waitRelease ? "Let go of the stick (back to center)…" : STICK_PROMPTS[i]!.text}</div>
              <p className="muted">Step {i + 1} of 4. The tool watches which channel moves.</p>
              <button onClick={() => setMode("idle")}>Cancel</button>
            </div>
          ) : (
            <button className="primary" onClick={() => { setFound({}); setI(0); base.current = []; setWaitRelease(false); setMode("map"); }}>Detect sticks</button>
          )}
          {Object.keys(found).length > 0 && (
            <table className="grid compact"><tbody>
              {STICK_PROMPTS.map((s) => found[s.key] && <tr key={s.key}><td>{s.key}</td><td>channel {found[s.key]!.ch}</td><td>{found[s.key]!.rev ? "reversed" : "normal"}</td></tr>)}
            </tbody></table>
          )}
          {allFound && mode === "idle" && <button className="primary" onClick={useMapping}>Use this mapping</button>}

          <h3>2. Stick travel</h3>
          {mode === "range" ? (
            <div className="prompt">
              <div className="big-prompt">Move every stick to every corner a few times. Then center the sticks, put the throttle all the way down, and click Done.</div>
              <button className="primary" onClick={finishRanges}>Done</button> <button onClick={() => setMode("idle")}>Cancel</button>
            </div>
          ) : <button onClick={() => { range.current = {}; setMode("range"); }}>Measure stick travel</button>}

          <table className="grid compact">
            <thead><tr><th>Stick</th><th>Channel</th><th>Now</th><th>Range</th></tr></thead>
            <tbody>{chans.map(([k, c]) => {
              const r = mode === "range" ? range.current[c] : p.rc.ranges[c];
              return (
                <tr key={k}><td>{k}</td><td>{c}{p.rc.reversed[c] ? " (rev)" : ""}</td>
                  <td><Bar value={live.rc[c - 1] ?? 0} mark={p.rc.ranges[c]?.trim} /> <span className="mono">{live.rc[c - 1] ?? "—"}</span></td>
                  <td className="mono">{r ? `${r.min}–${r.max}` : "not measured"}</td></tr>
              );
            })}</tbody>
          </table>
        </div>
        <div><RcBars channels={8} highlight={[p.rc.roll, p.rc.pitch, p.rc.throttle, p.rc.yaw]} /></div>
      </div>
    </StepShell>
  );
}

// ---------------- Flight modes ----------------
const slotOf = (pwm: number) => (pwm <= 1230 ? 0 : pwm <= 1360 ? 1 : pwm <= 1490 ? 2 : pwm <= 1620 ? 3 : pwm <= 1749 ? 4 : 5);
const ALLOWED = [0, 5, 4];

export function ModesStep({ p, d }: { p: Profile; d: Derived }) {
  const live = useLive();
  const s = useSession();
  const [detect, setDetect] = useState(false);
  const base = useRef<number[]>([]);
  useEffect(() => {
    if (!detect) return;
    if (!base.current.length) { base.current = live.rc.slice(0, 16); return; }
    const sticks = [p.rc.roll, p.rc.pitch, p.rc.throttle, p.rc.yaw];
    for (let c = 5; c <= 16; c++) {
      if (sticks.includes(c)) continue;
      if (Math.abs((live.rc[c - 1] ?? 0) - (base.current[c - 1] ?? 0)) > 200) {
        updateProfile((x) => ({ ...x, modes: { ...x.modes, channel: c } }));
        setDetect(false);
        return;
      }
    }
  }, [live.rc, detect, p.rc]);

  const pwm = live.rc[p.modes.channel - 1] ?? 0;
  const active = slotOf(pwm);
  return (
    <StepShell title="Flight modes" d={d} steps={["modes"]}
      intro={<p>The team flies in MANUAL. FBWA (wings-level assist) and ACRO are the only other modes allowed, and the Mission Planner mode buttons are blocked for everything else. A sensible switch: MANUAL in most positions, FBWA in one.</p>}>
      <div className="row">
        <label className="field inline">Mode switch channel
          <select value={p.modes.channel} onChange={(e) => updateProfile((x) => ({ ...x, modes: { ...x.modes, channel: Number(e.target.value) } }))}>
            {Array.from({ length: 12 }, (_, i) => i + 5).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        {detect ? <span className="big-prompt small">Flip the mode switch…</span>
          : <button onClick={() => { base.current = []; setDetect(true); }}>Detect by flipping the switch</button>}
        <span className="muted">Now: {pwm || "—"} µs → position {active + 1}. Board is in {MODE_NAMES[s.mode] ?? `mode ${s.mode}`}.</span>
      </div>
      <table className="grid compact">
        <thead><tr><th>Switch position</th><th>PWM</th><th>Mode</th></tr></thead>
        <tbody>{p.modes.slots.map((m, i) => (
          <tr key={i} className={i === active ? "changed-row" : ""}>
            <td>{i + 1}{i === active ? " ◀ now" : ""}</td>
            <td className="mono">{["≤1230", "1231–1360", "1361–1490", "1491–1620", "1621–1749", "≥1750"][i]}</td>
            <td><select value={m} onChange={(e) => updateProfile((x) => { const slots = [...x.modes.slots]; slots[i] = Number(e.target.value); return { ...x, modes: { ...x.modes, slots } }; })}>
              {!ALLOWED.includes(m) && <option value={m}>{`mode ${m} (not allowed)`}</option>}
              {ALLOWED.map((a) => <option key={a} value={a}>{MODE_NAMES[a]}</option>)}
            </select></td>
          </tr>
        ))}</tbody>
      </table>
    </StepShell>
  );
}
