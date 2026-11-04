/**
 * "Airframe and outputs": a top-down diagram of the plane where surfaces are placed freely,
 * input chips are dragged onto surfaces, and surfaces/motors are dragged onto the board's pads.
 * The surface kind, side and name are worked out from the mix and position; nobody picks an
 * ArduPilot function. A grid view shows the same mix as a table.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import {
  CANVAS, CORE_RULES, DEFAULT_ENDPOINTS, TEMPLATES, addInput, defaultMotorPos, diffCompiled, evalMix, fallbackFunction,
  inputLabel, inputQuestion, isUpright, kindLabel, motor, nativeFunction, normalizeSurface, sideOf, spoilerInput,
  termToUi, uiToTerm, withLayout,
  type CustomInput, type Motor, type MixTerm, type OneWay, type Profile, type Rect, type Silhouette, type StepId, type Surface,
} from "@husky/profile";
import { session, useSession } from "../state.ts";
import { EndpointSlider, Slider } from "../components/Sliders.tsx";
import { Bar, StepShell, useLive } from "./common.tsx";
import { confirmProps, updateProfile, type Derived } from "./store.ts";
import { Help } from "../components/Help.tsx";

/** Everything this screen owns on the board. */
const OWNS: StepId[] = ["outputs", "motor", "directions", "trims"];

type Sel = { type: "surface" | "motor"; id: string } | null;
type Inputs = Record<string, number>;

const AXES = ["roll", "pitch", "yaw", "flap", "throttle"] as const;
const MIME_INPUT = "text/x-husky-input";
const MIME_THING = "text/x-husky-thing";
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// ---------- profile edits ----------
const editSurface = (id: string, fn: (s: Surface) => Surface) =>
  updateProfile((x) => ({ ...x, surfaces: x.surfaces.map((s) => (s.id === id ? normalizeSurface(fn(s), x.inputs) : s)) }));
const editMotor = (id: string, patch: Partial<Motor>) =>
  updateProfile((x) => ({ ...x, motors: x.motors.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));

function assignOutput(sel: NonNullable<Sel>, n: number | undefined) {
  updateProfile((x) => {
    // whatever was on that pad becomes unplugged
    const free = (o?: number) => (n !== undefined && o === n ? undefined : o);
    return {
      ...x,
      surfaces: x.surfaces.map((s) => (sel.type === "surface" && s.id === sel.id ? { ...s, output: n } : { ...s, output: free(s.output) })),
      motors: x.motors.map((m) => (sel.type === "motor" && m.id === sel.id ? { ...m, output: n } : { ...m, output: free(m.output) })),
    };
  });
}

// ---------- preview / transmitter inputs ----------
function fromTransmitter(p: Profile, rc: number[]): Inputs {
  const b = session.params;
  const g = (n: string) => b.get(n)?.value;
  const bip = (ch: number) => {
    const v = rc[ch - 1]; if (!v) return 0;
    const t = g(`RC${ch}_TRIM`) ?? 1500, mn = g(`RC${ch}_MIN`) ?? 1000, mx = g(`RC${ch}_MAX`) ?? 2000;
    const r = g(`RC${ch}_REVERSED`) === 1 ? -1 : 1;
    const x = v >= t ? (v - t) / Math.max(1, mx - t) : (v - t) / Math.max(1, t - mn);
    return Math.max(-1, Math.min(1, x)) * r;
  };
  const uni = (ch: number) => {
    const v = rc[ch - 1]; if (!v) return 0;
    const mn = g(`RC${ch}_MIN`) ?? 1000, mx = g(`RC${ch}_MAX`) ?? 2000;
    const x = Math.max(0, Math.min(1, (v - mn) / Math.max(1, mx - mn)));
    return g(`RC${ch}_REVERSED`) === 1 ? 1 - x : x;
  };
  const out: Inputs = { roll: bip(p.rc.roll), pitch: bip(p.rc.pitch), yaw: bip(p.rc.yaw), throttle: uni(p.rc.throttle), flap: p.flapChannel ? uni(p.flapChannel) : 0 };
  for (const i of p.inputs) out[i.id] = i.range === "unipolar" ? uni(i.rc) : bip(i.rc);
  return out;
}

/** The RC channel PWMs that would produce these inputs (for driving the real servos). */
function toOverride(p: Profile, inputs: Inputs): Record<number, number> {
  const g = (n: string) => session.params.get(n)?.value;
  const bip = (ch: number, x: number) => {
    const t = g(`RC${ch}_TRIM`) ?? 1500, mn = g(`RC${ch}_MIN`) ?? 1000, mx = g(`RC${ch}_MAX`) ?? 2000;
    const v = g(`RC${ch}_REVERSED`) === 1 ? -x : x;
    return Math.round(v >= 0 ? t + v * (mx - t) : t + v * (t - mn));
  };
  const uni = (ch: number, x: number) => {
    const mn = g(`RC${ch}_MIN`) ?? 1000, mx = g(`RC${ch}_MAX`) ?? 2000;
    const v = g(`RC${ch}_REVERSED`) === 1 ? 1 - x : x;
    return Math.round(mn + v * (mx - mn));
  };
  const out: Record<number, number> = {
    [p.rc.roll]: bip(p.rc.roll, inputs.roll ?? 0), [p.rc.pitch]: bip(p.rc.pitch, inputs.pitch ?? 0), [p.rc.yaw]: bip(p.rc.yaw, inputs.yaw ?? 0),
    [p.rc.throttle]: uni(p.rc.throttle, 0), // never the motor: throttle stays closed
  };
  if (p.flapChannel) out[p.flapChannel] = uni(p.flapChannel, inputs.flap ?? 0);
  for (const i of p.inputs) out[i.rc] = i.range === "unipolar" ? uni(i.rc, inputs[i.id] ?? 0) : bip(i.rc, inputs[i.id] ?? 0);
  return out;
}

// =====================================================================

export function AirframeOutputsStep({ p, d }: { p: Profile; d: Derived }) {
  const live = useLive();
  const [sel, setSel] = useState<Sel>(null);
  const [view, setView] = useState<"diagram" | "grid">("diagram");
  const [preview, setPreview] = useState<Inputs>({ roll: 0, pitch: 0, yaw: 0, throttle: 0, flap: 0 });
  const [followTx, setFollowTx] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [liveOut, setLiveOut] = useState(false);
  const sess = useSession();

  // older profiles (or imports) without diagram positions get a layout once
  useEffect(() => {
    if (p.surfaces.some((s) => !s.pos) || p.motors.some((m) => !m.pos) || !p.silhouette) updateProfile(withLayout);
  }, [p]);

  const inputs: Inputs = followTx && live.rc.length ? fromTransmitter(p, live.rc) : preview;
  const hasTx = live.rcCount > 0;

  // ---- live output: on-screen sticks drive the real servos, edits are written as you make them ----
  const coreErrors = d.findings.filter((f) => CORE_RULES.has(f.rule) && OWNS.includes(f.step as StepId));
  const pending = diffCompiled(d.compiled, d.board, OWNS);
  const pendingKey = JSON.stringify(pending.map((c) => [c.name, c.value]));
  useEffect(() => {
    if (!liveOut) return;
    if (sess.armed || sess.phase !== "ready") { setLiveOut(false); setMsg("Live output stopped: the board is armed or the link dropped."); return; }
    if (!pending.length || sess.busy) return;
    if (coreErrors.length) { setMsg(`Not sending: ${coreErrors[0]!.message}`); return; }
    const t = setTimeout(() => { void session.write(pending, "Live update"); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveOut, pendingKey, sess.armed, sess.phase, sess.busy]);
  const overrideKey = liveOut && !followTx ? JSON.stringify(toOverride(p, inputs)) : "";
  useEffect(() => {
    if (!overrideKey) return;
    try { session.startOverride(JSON.parse(overrideKey)); } catch (e) { setMsg((e as Error).message); setLiveOut(false); }
  }, [overrideKey]);
  useEffect(() => { if (!liveOut || followTx) void session.stopOverride(); }, [liveOut, followTx]);
  useEffect(() => () => { void session.stopOverride(); }, []);

  async function toggleLive(on: boolean) {
    if (!on) { setLiveOut(false); return; }
    const ok = confirm(
      "Drive the real servos?\n\n" +
      "Control surfaces may move suddenly or incorrectly if they aren't configured properly yet. " +
      "Every change on this screen is written to the board immediately, without the review step.\n\n" +
      "The throttle is held closed and the board must stay disarmed. Remove the propeller and keep hands clear.");
    if (!ok) return;
    confirmProps();
    if (sess.mode !== 0) await session.setMode(0);
    setLiveOut(true);
  }

  const selSurface = sel?.type === "surface" ? p.surfaces.find((s) => s.id === sel.id) : undefined;
  const selMotor = sel?.type === "motor" ? p.motors.find((m) => m.id === sel.id) : undefined;

  function applyTemplate(id: string) {
    const t = TEMPLATES.find((x) => x.id === id)!;
    if (p.surfaces.length && !confirm(`Replace the ${p.surfaces.length} surfaces you have with the "${t.label}" layout?`)) return;
    updateProfile((x) => withLayout({
      ...x, silhouette: t.silhouette,
      surfaces: t.surfaces(),
      inputs: t.needsSpoilerInput && !x.inputs.some((i) => i.id === "spoiler") ? [...x.inputs, spoilerInput(7)] : x.inputs,
      motors: x.motors.length ? x.motors : [{ ...motor(), pos: defaultMotorPos() }],
    }));
    setSel(null);
  }

  function newSurfaceAt(pt: { x: number; y: number }, input?: string) {
    const s0: Surface = { id: uid("srf"), name: "Surface", kind: "mechanism", mix: [], autoName: true, failsafe: "pose",
      pos: { x: Math.round(pt.x - 60), y: Math.round(pt.y - 14), w: 120, h: 28 } };
    const s = input ? addInput(s0, input, p) : normalizeSurface(s0, p.inputs);
    updateProfile((x) => ({ ...x, surfaces: [...x.surfaces, s] }));
    setSel({ type: "surface", id: s.id });
  }

  const deflection = (s: Surface) => (s.kind === "fixed" ? 0 : evalMix(s.mix, inputs));

  return (
    <StepShell title="Airframe and outputs" d={d} steps={OWNS}
      intro={<p>Place each surface, drag inputs onto it, then drag it to its pad.</p>}
      help="The tool works out each surface's type (aileron, spoileron, ruddervator...) and whether ArduPilot or the companion script drives it." docs={["servo", "fourCh", "elevon", "vtail", "flaperon"]}>
      <div className="af-toolbar">
        <span className="muted">Start from</span>
        {TEMPLATES.map((t) => <button key={t.id} className="small" title={t.description} onClick={() => applyTemplate(t.id)}>{t.label}</button>)}
        <span className="spacer" />
        <button className="small" onClick={() => newSurfaceAt({ x: 560, y: 150 })}>+ Surface</button>
        <button className="small" onClick={() => {
          const m = { ...motor(), pos: defaultMotorPos(p.motors.length) };
          updateProfile((x) => ({ ...x, motors: [...x.motors, m] })); setSel({ type: "motor", id: m.id });
        }}>+ Motor</button>
        <select className="small" value={p.silhouette ?? "conventional"} title="Outline drawn behind the surfaces"
          onChange={(e) => updateProfile((x) => ({ ...x, silhouette: e.target.value as Silhouette }))}>
          <option value="conventional">conventional outline</option><option value="vtail">V-tail outline</option>
          <option value="wing">flying-wing outline</option><option value="none">no outline</option>
        </select>
        <label className={`check live-toggle ${liveOut ? "on" : ""}`} title="On-screen sticks move the real servos; changes are written immediately">
          <input type="checkbox" checked={liveOut} disabled={sess.armed || !session.canWrite} onChange={(e) => void toggleLive(e.target.checked)} /> Drive the real servos
        </label>
        <div className="seg">
          <button className={view === "diagram" ? "on" : ""} onClick={() => setView("diagram")}>Diagram</button>
          <button className={view === "grid" ? "on" : ""} onClick={() => setView("grid")}>Grid</button>
        </div>
      </div>

      {liveOut && <p className="live-banner">LIVE: the on-screen sticks move the real servos and every change goes to the board immediately. Surfaces may move suddenly. Throttle is held closed.</p>}
      <InputsBox p={p} rc={live.rc} />

      <div className="af-main">
        <div className="af-canvas-wrap">
          {view === "diagram"
            ? <PlaneCanvas p={p} sel={sel} setSel={setSel} deflection={deflection} onNewSurface={newSurfaceAt} setMsg={setMsg} />
            : <MixGrid p={p} sel={sel} setSel={setSel} />}
          <Preview p={p} inputs={inputs} setPreview={setPreview} followTx={followTx} setFollowTx={setFollowTx} hasTx={hasTx} />
        </div>
        <div className="af-inspector">
          {selSurface ? <SurfaceInspector s={selSurface} p={p} servo={live.servo} onDelete={() => { updateProfile((x) => ({ ...x, surfaces: x.surfaces.filter((y) => y.id !== selSurface.id) })); setSel(null); }} />
            : selMotor ? <MotorInspector m={selMotor} d={d} onDelete={() => { updateProfile((x) => ({ ...x, motors: x.motors.filter((y) => y.id !== selMotor.id) })); setSel(null); }} />
            : <p className="muted">Select a surface or motor. Drag to move, drag the corner to resize. Drop an input on empty space to add a surface.</p>}
        </div>
      </div>

      {msg && <p className="warn-box" onClick={() => setMsg(undefined)}>{msg}</p>}
      <BoardStrip p={p} d={d} sel={sel} setSel={setSel} setMsg={setMsg} servo={live.servo} />
    </StepShell>
  );
}

// ---------- palette ----------
function Chip({ input, p, text }: { input: string; p: Profile; text?: string }) {
  return (
    <span className={`chip-in ${(AXES as readonly string[]).includes(input) ? "axis" : "custom"}`} draggable
      onDragStart={(e) => { e.dataTransfer.setData(MIME_INPUT, input); e.dataTransfer.effectAllowed = "copy"; }}
      title="Drag onto a surface (or onto empty space to make a new one)">
      {text ?? inputLabel(input, p.inputs)}
    </span>
  );
}

/** Live position of an RC channel as a small bar (−1..1 or 0..1). */
function MiniBar({ v, unipolar }: { v: number; unipolar?: boolean }) {
  const w = unipolar ? v : (v + 1) / 2;
  return <span className={`minibar ${unipolar ? "uni" : ""}`}><span style={{ width: `${Math.max(0, Math.min(1, w)) * 100}%` }} /></span>;
}

/** All inputs, always visible and editable, whatever is selected on the plane. */
function InputsBox({ p, rc }: { p: Profile; rc: number[] }) {
  const tx = fromTransmitter(p, rc);
  const editIn = (id: string, patch: Partial<CustomInput>) => updateProfile((x) => ({ ...x, inputs: x.inputs.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  const taken = (ch: number, self?: string) =>
    [p.rc.roll, p.rc.pitch, p.rc.throttle, p.rc.yaw, p.modes.channel].includes(ch) || (p.flapChannel === ch && self !== "flap") || p.inputs.some((i) => i.rc === ch && i.id !== self);
  const chSelect = (value: number | undefined, onPick: (c: number | undefined) => void, self?: string) => (
    <select className="small" value={value ?? ""} onChange={(e) => onPick(e.target.value ? Number(e.target.value) : undefined)}>
      {value === undefined && <option value="">pick a channel</option>}
      {Array.from({ length: 16 }, (_, k) => k + 1).map((c) => <option key={c} value={c} disabled={c !== value && taken(c, self)}>RC{c}{c !== value && taken(c, self) ? " (in use)" : ""}</option>)}
    </select>
  );
  /** Surfaces whose mix uses this input. */
  const usedBy = (id: string) => p.surfaces.filter((x) => x.mix.some((t) => t.in === id)).map((x) => x.name);
  /** Take an input off every surface (and the input list, for custom ones). */
  function remove(id: string, label: string) {
    const users = usedBy(id);
    if (users.length && !confirm(`Delete "${label}"?\n\nIt is mixed into ${users.join(", ")}. Those surfaces will stop responding to it.`)) return;
    updateProfile((x) => ({
      ...x,
      inputs: x.inputs.filter((y) => y.id !== id),
      flapChannel: id === "flap" ? undefined : x.flapChannel,
      surfaces: x.surfaces.map((y) => (y.mix.some((t) => t.in === id) ? normalizeSurface({ ...y, mix: y.mix.filter((t) => t.in !== id) }, x.inputs.filter((z) => z.id !== id)) : y)),
    }));
  }
  const pct = (v: number | undefined) => (v === undefined ? "—" : `${Math.round(v * 100)}%`);
  const usage = (id: string) => {
    const u = usedBy(id);
    return <span className="in-used muted" title={u.join(", ")}>{u.length ? u.join(", ") : "not used"}</span>;
  };
  const del = (id: string, label: string) => <button className="small link in-del" title={`Delete ${label}`} onClick={() => remove(id, label)}>×</button>;
  const flapOn = p.flapChannel !== undefined;

  return (
    <div className="inputs-box">
      <div className="row tight"><h3>Inputs</h3><span className="muted">drag a name onto a surface</span><span className="spacer" />
        {!flapOn && <button className="small" onClick={() => {
          const free = Array.from({ length: 16 }, (_, k) => k + 1).find((c) => c >= 5 && !taken(c, "flap")) ?? 6;
          updateProfile((x) => ({ ...x, flapChannel: free }));
        }}>+ Flap</button>}
        <button className="small" onClick={() => {
          const free = Array.from({ length: 16 }, (_, k) => k + 1).find((c) => c >= 5 && !taken(c)) ?? 9;
          updateProfile((x) => ({ ...x, inputs: [...x.inputs, { id: `in-${Date.now().toString(36)}`, label: "New input", rc: free, range: "unipolar" }] }));
        }}>+ New input</button></div>
      <div className="in-list">
        <div className="in-row head muted"><span>Input</span><span>Channel</span><span>Travel</span><span>Live</span><span /><span>Used by</span><span /></div>
        {(["roll", "pitch", "yaw"] as const).map((a) => (
          <div key={a} className="in-row">
            <Chip input={a} p={p} />
            <span className="muted" title="Set in the Sticks step">RC{p.rc[a]}</span>
            <span className="muted">centered ±</span>
            <MiniBar v={tx[a] ?? 0} />
            <span className="mono in-val">{pct(tx[a])}</span>
            {usage(a)}
            <span className="muted in-del" title="Stick axes can't be deleted">·</span>
          </div>
        ))}
        {flapOn && (
          <div className="in-row">
            <Chip input="flap" p={p} />
            {chSelect(p.flapChannel, (c) => updateProfile((x) => ({ ...x, flapChannel: c })), "flap")}
            <span className="muted">off → full</span>
            <MiniBar v={tx.flap ?? 0} unipolar />
            <span className="mono in-val">{pct(tx.flap)}</span>
            {usage("flap")}
            {del("flap", "Flap")}
          </div>
        )}
        {p.inputs.map((i) => (
          <div key={i.id} className="in-row">
            <span className="in-named"><Chip input={i.id} p={p} text="⠿ drag" />
              <input className="in-name" value={i.label} onChange={(e) => editIn(i.id, { label: e.target.value })} aria-label="Input name" title="Rename" /></span>
            {chSelect(i.rc, (c) => c && editIn(i.id, { rc: c }), i.id)}
            <select className="small" value={i.range} onChange={(e) => editIn(i.id, { range: e.target.value as CustomInput["range"] })}>
              <option value="unipolar">off → full</option><option value="bipolar">centered ±</option>
            </select>
            <MiniBar v={tx[i.id] ?? 0} unipolar={i.range === "unipolar"} />
            <span className="mono in-val">{pct(tx[i.id])}</span>
            {usage(i.id)}
            {del(i.id, i.label)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- the diagram ----------
function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const r = pt.matrixTransform(svg.getScreenCTM()!.inverse());
  return { x: r.x, y: r.y };
}
const snap = (v: number) => Math.round(v / 5) * 5;

function Silhouette({ kind }: { kind: Silhouette }) {
  if (kind === "none") return null;
  const c = "af-sil";
  if (kind === "wing") return (
    <g className={c}>
      <path d="M500 40 L940 330 L900 380 L560 300 L500 330 L440 300 L100 380 L60 330 Z" />
      <line x1="500" y1="20" x2="500" y2="540" className="af-axis" />
    </g>
  );
  return (
    <g className={c}>
      <rect x="478" y="30" width="44" height="500" rx="20" />
      <path d="M60 200 L478 185 L478 285 L60 285 Z" /><path d="M940 200 L522 185 L522 285 L940 285 Z" />
      {kind === "vtail"
        ? <><path d="M478 450 L310 500 L318 512 L478 480 Z" /><path d="M522 450 L690 500 L682 512 L522 480 Z" /></>
        : <><path d="M478 470 L340 488 L340 520 L478 520 Z" /><path d="M522 470 L660 488 L660 520 L522 520 Z" /></>}
      <line x1="500" y1="10" x2="500" y2="550" className="af-axis" />
      <text x="500" y="18" className="af-hint" textAnchor="middle">nose</text>
      <text x="40" y="190" className="af-hint">left wing</text><text x="960" y="190" className="af-hint" textAnchor="end">right wing</text>
    </g>
  );
}

function PlaneCanvas({ p, sel, setSel, deflection, onNewSurface, setMsg }: {
  p: Profile; sel: Sel; setSel: (s: Sel) => void; deflection: (s: Surface) => number;
  onNewSurface: (pt: { x: number; y: number }, input?: string) => void; setMsg: (m?: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "move" | "resize"; type: "surface" | "motor"; id: string; start: { x: number; y: number }; orig: Rect } | null>(null);
  const [ghost, setGhost] = useState<{ id: string; pos: Rect } | null>(null);

  const posOf = (id: string, pos?: Rect) => (ghost?.id === id ? ghost.pos : pos);

  function down(e: RPointerEvent, type: "surface" | "motor", id: string, pos: Rect, kind: "move" | "resize") {
    e.stopPropagation();
    setSel({ type, id });
    const svg = svgRef.current!;
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    drag.current = { kind, type, id, start: svgPoint(svg, e.clientX, e.clientY), orig: pos };
  }
  function move(e: RPointerEvent) {
    const g = drag.current; if (!g) return;
    const pt = svgPoint(svgRef.current!, e.clientX, e.clientY);
    const dx = pt.x - g.start.x, dy = pt.y - g.start.y;
    const o = g.orig;
    const pos = g.kind === "move"
      ? { ...o, x: snap(Math.max(0, Math.min(CANVAS.w - o.w, o.x + dx))), y: snap(Math.max(0, Math.min(CANVAS.h - o.h, o.y + dy))) }
      : { ...o, w: snap(Math.max(15, o.w + dx)), h: snap(Math.max(12, o.h + dy)) };
    setGhost({ id: g.id, pos });
  }
  function up() {
    const g = drag.current; drag.current = null;
    if (!g || !ghost || ghost.id !== g.id) { setGhost(null); return; }
    if (g.type === "surface") editSurface(g.id, (s) => ({ ...s, pos: ghost.pos }));
    else editMotor(g.id, { pos: ghost.pos });
    setGhost(null);
  }
  function drop(e: DragEvent) {
    const input = e.dataTransfer.getData(MIME_INPUT);
    if (!input) return;
    e.preventDefault();
    const target = (e.target as Element).closest("[data-sid]");
    const sid = target?.getAttribute("data-sid");
    if (sid) {
      const s = p.surfaces.find((x) => x.id === sid)!;
      if (s.kind === "fixed") { setMsg("That output has a fixed function; it doesn't take inputs."); return; }
      if (s.mix.length >= 3 && !s.mix.some((t) => t.in === input)) { setMsg(`${s.name} already mixes 3 inputs (the most a surface can take).`); return; }
      editSurface(sid, (x) => addInput(x, input, p));
      setSel({ type: "surface", id: sid });
    } else {
      onNewSurface(svgPoint(svgRef.current!, e.clientX, e.clientY), input);
    }
  }

  return (
    <svg ref={svgRef} className="af-canvas" viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`} role="img" aria-label="Airframe diagram"
      onPointerMove={move} onPointerUp={up} onPointerDown={() => setSel(null)}
      onDragOver={(e) => { if (e.dataTransfer.types.includes(MIME_INPUT)) e.preventDefault(); }} onDrop={drop}>
      <Silhouette kind={p.silhouette ?? "conventional"} />
      {p.surfaces.map((s) => {
        const pos = posOf(s.id, s.pos); if (!pos) return null;
        const nat = nativeFunction(s, p);
        const v = deflection(s);
        const upright = isUpright(s);
        const cls = s.kind === "fixed" || s.kind === "mechanism" ? "mech" : nat ? "native" : "script";
        const selected = sel?.type === "surface" && sel.id === s.id;
        const arrow = Math.abs(v) < 0.03 ? "" : upright ? (v > 0 ? "→" : "←") : (v > 0 ? "↑" : "↓");
        return (
          <g key={s.id} data-sid={s.id} className={`af-srf ${cls} ${selected ? "sel" : ""} ${!s.output ? "unplugged" : ""}`}
            onPointerDown={(e) => down(e, "surface", s.id, pos, "move")}>
            <rect x={pos.x} y={pos.y} width={pos.w} height={pos.h} rx="4" />
            {Math.abs(v) >= 0.03 && (
              <rect className={`defl ${v > 0 ? "pos" : "neg"}`} x={pos.x} y={pos.y} width={pos.w * Math.min(1, Math.abs(v))} height={pos.h} rx="4" />
            )}
            {pos.h > pos.w * 1.5
              ? <text x={pos.x + pos.w + 8} y={pos.y + 16} className="af-label">{s.name}</text>
              : <text x={pos.x + pos.w / 2} y={pos.y - 6} textAnchor="middle" className="af-label">{s.name}</text>}
            {pos.h > pos.w * 1.5
              ? <text x={pos.x + pos.w + 8} y={pos.y + 34} className="af-pad">{arrow ? `${arrow} ${Math.round(Math.abs(v) * 100)}%` : s.output ? `S${s.output}` : "not plugged in"}</text>
              : <text x={pos.x + pos.w / 2} y={pos.y + pos.h / 2 + 5} textAnchor="middle" className="af-pad">
                  {arrow ? `${arrow} ${Math.round(Math.abs(v) * 100)}%` : s.output ? `S${s.output}` : "—"}
                </text>}
            {selected && <rect className="af-handle" x={pos.x + pos.w - 6} y={pos.y + pos.h - 6} width="12" height="12"
              onPointerDown={(e) => down(e, "surface", s.id, pos, "resize")} />}
          </g>
        );
      })}
      {p.motors.map((m) => {
        const pos = posOf(m.id, m.pos); if (!pos) return null;
        const selected = sel?.type === "motor" && sel.id === m.id;
        return (
          <g key={m.id} className={`af-motor ${selected ? "sel" : ""} ${!m.output ? "unplugged" : ""}`} onPointerDown={(e) => down(e, "motor", m.id, pos, "move")}>
            <rect x={pos.x} y={pos.y} width={pos.w} height={pos.h} rx={pos.h / 2} />
            <text x={pos.x + pos.w / 2} y={pos.y + pos.h / 2 + 5} textAnchor="middle" className="af-pad">{m.output ? `${m.name} S${m.output}` : m.name}</text>
          </g>
        );
      })}
      {p.surfaces.length === 0 && <text x="500" y="380" textAnchor="middle" className="af-hint big">Pick a starting layout above, or drag an input (e.g. Roll) onto the plane</text>}
    </svg>
  );
}

// ---------- inspector ----------
function SurfaceInspector({ s, p, servo, onDelete }: { s: Surface; p: Profile; servo: number[]; onDelete: () => void }) {
  const nat = nativeFunction(s, p);
  const fb = !nat && s.kind !== "fixed" ? fallbackFunction(s, p) : undefined;
  const upright = isUpright(s);
  const unused = [...AXES.filter((a) => a !== "throttle"), ...p.inputs.map((i) => i.id)].filter((i) => !s.mix.some((t) => t.in === i));
  const ep = { min: s.min ?? DEFAULT_ENDPOINTS.min, trim: s.trim ?? DEFAULT_ENDPOINTS.trim, max: s.max ?? DEFAULT_ENDPOINTS.max };
  const setTerm = (k: number, t: MixTerm) => editSurface(s.id, (x) => ({ ...x, mix: x.mix.map((m, i) => (i === k ? t : m)) }));

  return (
    <div className="insp">
      <div className="row tight">
        <input className="insp-name" value={s.name} onChange={(e) => editSurface(s.id, (x) => ({ ...x, name: e.target.value, autoName: false }))} />
        {s.autoName === false && s.kind !== "fixed" && <button className="small" title="Name it after what it is" onClick={() => editSurface(s.id, (x) => ({ ...x, autoName: true }))}>auto</button>}
      </div>
      <p className="muted">{s.kind === "fixed" ? `Fixed output function ${s.fixedFunction}` : `${sideOf(s)} side · ${kindLabel(s.kind)}`}</p>
      {s.kind !== "fixed" && (
        <>
          <label className="check"><input type="checkbox" checked={upright} onChange={(e) => editSurface(s.id, (x) => ({ ...x, upright: e.target.checked }))} /> stands upright (rudder, steering)</label>
          {s.mix.length === 0 && <p className="muted">No inputs. Drag one on, or add below.</p>}
          {s.mix.map((t, k) => {
            const u = termToUi(t);
            const q = inputQuestion(t.in, s, p.inputs);
            const set = (patch: Partial<typeof u>) => setTerm(k, uiToTerm(t.in, { ...u, ...patch }));
            return (
              <div key={t.in} className="term">
                <div className="row tight"><strong>{inputLabel(t.in, p.inputs)}</strong><span className="spacer" />
                  <button className="small link" onClick={() => editSurface(s.id, (x) => ({ ...x, mix: x.mix.filter((_, i) => i !== k) }))}>remove</button></div>
                <div className="row tight">
                  <span>{q.when}, this goes</span>
                  <div className="seg">
                    <button className={u.dir > 0 ? "on" : ""} onClick={() => set({ dir: 1 })}>{q.plus}</button>
                    <button className={u.dir < 0 ? "on" : ""} onClick={() => set({ dir: -1 })}>{q.minus}</button>
                  </div>
                </div>
                <div className="row tight">
                  <span className="muted">moves</span>
                  <select value={u.oneWay} onChange={(e) => set({ oneWay: e.target.value as OneWay })}>
                    <option value="both">both ways</option>
                    <option value="plus">only {q.plus.toLowerCase()} (never {q.minus.toLowerCase()})</option>
                    <option value="minus">only {q.minus.toLowerCase()} (never {q.plus.toLowerCase()})</option>
                  </select>
                </div>
              </div>
            );
          })}
          {s.mix.length < 3 && (
            <select value="" onChange={(e) => e.target.value && editSurface(s.id, (x) => addInput(x, e.target.value, p))}>
              <option value="">+ add an input…</option>
              {unused.map((i) => <option key={i} value={i}>{inputLabel(i, p.inputs)}</option>)}
            </select>
          )}
          <p className={`badge-line ${nat ? "good" : "warn"}`}>
            {s.mix.length === 0 ? "No inputs yet" : nat ? `ArduPilot drives this natively (${nat.label})` : `The companion script mixes this. If the script stops it acts as ${fb?.label}.`}
          </p>
        </>
      )}
      {s.kind !== "fixed" && (
        <div className="term">
          <div className="row tight"><strong>Servo travel</strong><Help docs={["fourCh"]}>Center: surface straight. Ends: full throw without the servo buzzing. Reverse PWM if the servo moves opposite to the diagram.</Help><span className="spacer" />
            <label className="check"><input type="checkbox" checked={!!s.reversed} onChange={(e) => editSurface(s.id, (x) => ({ ...x, reversed: e.target.checked }))} /> Reverse PWM</label></div>
          <EndpointSlider min={ep.min} trim={ep.trim} max={ep.max} reversed={!!s.reversed} live={s.output ? servo[s.output - 1] : undefined}
            onChange={(f, us) => editSurface(s.id, (x) => ({ ...x, min: ep.min, trim: ep.trim, max: ep.max, [f]: us }))} />
        </div>
      )}
      <p>Plugged into: <strong>{s.output ? `S${s.output}` : "nothing yet"}</strong> {s.output
        ? <button className="small link" onClick={() => assignOutput({ type: "surface", id: s.id }, undefined)}>unplug</button>
        : <span className="muted">(drag to a pad below)</span>}</p>
      {(s.kind === "mechanism" || s.kind === "fixed") && (
        <label className="field inline">During RC-loss failsafe
          <select value={s.failsafe ?? "hold"} onChange={(e) => editSurface(s.id, (x) => ({ ...x, failsafe: e.target.value as Surface["failsafe"] }))}>
            <option value="hold">stays where it is</option><option value="trim">goes to center</option><option value="min">goes to low end</option><option value="max">goes to high end</option>
          </select>
        </label>
      )}
      <details className="adv"><summary>Advanced</summary>
        {upright && s.mix.length === 1 && s.mix[0]!.in === "yaw" && (
          <label className="check"><input type="checkbox" checked={!!s.groundSteering} onChange={(e) => editSurface(s.id, (x) => ({ ...x, groundSteering: e.target.checked }))} /> ground steering only (ArduPilot fades it out in the air)</label>
        )}
        {s.mix.length > 1 && (
          <div className="term">
            <strong>Mix ratio<Help>How hard each input drives this surface when several are mixed. Servo travel sets the overall range.</Help></strong>
            {s.mix.map((t, k) => {
              const u = termToUi(t);
              return (
                <div key={t.in} className="row tight"><span>{inputLabel(t.in, p.inputs)}</span><span className="spacer" />
                  <Slider min={5} max={100} step={5} value={Math.round(u.amount * 100)} onChange={(v) => setTerm(k, uiToTerm(t.in, { ...u, amount: v / 100 }))} />
                  <span className="mono">{Math.round(u.amount * 100)}%</span></div>
              );
            })}
          </div>
        )}
        <p className="muted mono">mix: {JSON.stringify(s.mix)}</p>
      </details>
      <button className="small" onClick={onDelete}>Delete surface</button>
    </div>
  );
}

function MotorInspector({ m, d, onDelete }: { m: Motor; d: Derived; onDelete: () => void }) {
  return (
    <div className="insp">
      <input className="insp-name" value={m.name} onChange={(e) => editMotor(m.id, { name: e.target.value })} />
      <label className="field inline">Position
        <select value={m.position} onChange={(e) => editMotor(m.id, { position: e.target.value as Motor["position"] })}>
          <option value="center">single / center</option><option value="left">left (twin)</option><option value="right">right (twin)</option>
        </select>
      </label>
      <label className="field inline">Signal
        <select value={m.protocol} onChange={(e) => editMotor(m.id, { protocol: e.target.value as Motor["protocol"] })}>
          <option value="PWM">PWM (normal ESC, needs calibration)</option><option value="DSHOT150">DShot150 (long wires)</option>
          <option value="DSHOT300">DShot300</option><option value="DSHOT600">DShot600</option><option value="DSHOT1200">DShot1200</option>
        </select>
      </label>
      {m.protocol !== "PWM" && (
        <label className="check"><input type="checkbox" checked={m.bidir} onChange={(e) => editMotor(m.id, { bidir: e.target.checked, telemetry: e.target.checked ? "bidir" : m.telemetry === "bidir" ? "none" : m.telemetry })} /> bidirectional DShot (RPM on the signal wire)</label>
      )}
      <label className="field inline">ESC telemetry
        <select value={m.telemetry} onChange={(e) => editMotor(m.id, { telemetry: e.target.value as Motor["telemetry"] })}>
          <option value="none">none</option>{m.bidir && <option value="bidir">from bidirectional DShot</option>}<option value="serial">telemetry wire to a serial pad</option>
        </select>
      </label>
      {m.telemetry === "serial" && (
        <label className="field inline">wire on
          <select value={m.telemetrySerial ?? ""} onChange={(e) => editMotor(m.id, { telemetrySerial: Number(e.target.value) })}>
            <option value="" disabled>choose</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].filter((n) => d.board.has(`SERIAL${n}_PROTOCOL`)).map((n) => <option key={n} value={n}>SERIAL{n}{session.hwdef?.serialOrder[n] ? ` (${session.hwdef.serialOrder[n]} RX pad)` : ""}</option>)}
          </select>
        </label>
      )}
      <label className="field inline">Motor magnets (poles) <input className="num short" type="number" min={2} max={60} step={2} value={m.poles} onChange={(e) => editMotor(m.id, { poles: Number(e.target.value) })} /></label>
      <p>Plugged into: <strong>{m.output ? `S${m.output}` : "nothing yet"}</strong> {m.output && <button className="small link" onClick={() => assignOutput({ type: "motor", id: m.id }, undefined)}>unplug</button>}</p>
      <button className="small" onClick={onDelete}>Delete motor</button>
    </div>
  );
}

// ---------- grid view ----------
function MixGrid({ p, sel, setSel }: { p: Profile; sel: Sel; setSel: (s: Sel) => void }) {
  const cols = useMemo(() => {
    const used = new Set(p.surfaces.flatMap((s) => s.mix.map((t) => t.in)));
    return [...AXES.filter((a) => a !== "throttle"), ...p.inputs.map((i) => i.id)].filter((v) => v !== "flap" || used.has("flap") || p.flapChannel);
  }, [p]);
  return (
    <table className="grid mixgrid">
      <thead><tr><th>Surface</th>{cols.map((c) => <th key={c}>{inputLabel(c, p.inputs)}</th>)}<th>Pad</th></tr></thead>
      <tbody>{p.surfaces.filter((s) => s.kind !== "fixed").map((s) => (
        <tr key={s.id} className={sel?.id === s.id ? "changed-row" : ""} onClick={() => setSel({ type: "surface", id: s.id })}>
          <td><strong>{s.name}</strong><div className="muted">{kindLabel(s.kind)}</div></td>
          {cols.map((c) => {
            const k = s.mix.findIndex((t) => t.in === c);
            const t = k >= 0 ? s.mix[k] : undefined;
            const u = t ? termToUi(t) : undefined;
            const q = inputQuestion(c, s, p.inputs);
            const setDir = (v: string) => editSurface(s.id, (x) => {
              if (v === "") return { ...x, mix: x.mix.filter((m) => m.in !== c) };
              const dir = v === "+" ? 1 : -1;
              if (!t) return x.mix.length >= 3 ? x : { ...x, mix: [...x.mix, uiToTerm(c, { dir, amount: 1, oneWay: "both" })] };
              return { ...x, mix: x.mix.map((m) => (m.in === c ? uiToTerm(c, { ...u!, dir }) : m)) };
            });
            return (
              <td key={c} title={q.when}>
                <select value={u ? (u.dir > 0 ? "+" : "-") : ""} onClick={(e) => e.stopPropagation()} onChange={(e) => setDir(e.target.value)}>
                  <option value="">—</option><option value="+">{q.plus}</option><option value="-">{q.minus}</option>
                </select>
                {u && u.oneWay !== "both" && <span className="muted"> one way</span>}
              </td>
            );
          })}
          <td className="mono">{s.output ? `S${s.output}` : "—"}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

// ---------- preview ----------
function Stick({ x, y, onChange, springX = true, springY = true, label }: {
  x: number; y: number; onChange: (x: number, y: number) => void; springX?: boolean; springY?: boolean; label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const set = (e: RPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    onChange(nx, ny);
  };
  return (
    <div className="stickbox">
      <div ref={ref} className="stick" onPointerDown={(e) => { try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ } set(e); }}
        onPointerMove={(e) => { if (e.buttons) set(e); }}
        onPointerUp={() => onChange(springX ? 0 : x, springY ? 0 : y)}>
        <span className="knob" style={{ left: `${(x + 1) * 50}%`, top: `${(y + 1) * 50}%` }} />
      </div>
      <span className="muted">{label}</span>
    </div>
  );
}

function Preview({ p, inputs, setPreview, followTx, setFollowTx, hasTx }: {
  p: Profile; inputs: Inputs; setPreview: (f: (i: Inputs) => Inputs) => void; followTx: boolean; setFollowTx: (b: boolean) => void; hasTx: boolean;
}) {
  const extra = p.inputs;
  const thrY = 1 - 2 * (inputs.throttle ?? 0); // screen y: up = full
  return (
    <div className="preview">
      <span className="muted">Preview</span>
      <Stick label="throttle / yaw" x={inputs.yaw ?? 0} y={thrY} springY={false}
        onChange={(x, y) => setPreview((i) => ({ ...i, yaw: x, throttle: (1 - y) / 2 }))} />
      <Stick label="pitch / roll" x={inputs.roll ?? 0} y={inputs.pitch ?? 0}
        onChange={(x, y) => setPreview((i) => ({ ...i, roll: x, pitch: y }))} />
      <div className="sliders">
        <label>Flap <Slider min={0} max={100} value={Math.round((inputs.flap ?? 0) * 100)} onChange={(v) => setPreview((i) => ({ ...i, flap: v / 100 }))} /></label>
        {extra.map((c) => (
          <label key={c.id}>{c.label} <Slider min={c.range === "unipolar" ? 0 : -100} max={100} value={Math.round((inputs[c.id] ?? 0) * 100)}
            onChange={(v) => setPreview((i) => ({ ...i, [c.id]: v / 100 }))} /></label>
        ))}
      </div>
      <label className="check" title={hasTx ? "" : "No RC signal right now"}>
        <input type="checkbox" checked={followTx} disabled={!hasTx} onChange={(e) => setFollowTx(e.target.checked)} /> use my transmitter
      </label>
      <button className="small" onClick={() => setPreview(() => ({ roll: 0, pitch: 0, yaw: 0, throttle: 0, flap: 0 }))}>center</button>
    </div>
  );
}

// ---------- board pinout ----------
const GROUP_CLASS = ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7"];

function BoardStrip({ p, d, sel, setSel, setMsg, servo }: {
  p: Profile; d: Derived; sel: Sel; setSel: (s: Sel) => void; setMsg: (m?: string) => void; servo: number[];
}) {
  const groups = d.facts.timerGroups;
  const groupOf = (n: number) => groups?.findIndex((g) => g.includes(n)) ?? -1;
  const bidir = new Set(session.hwdef?.pwm.filter((x) => x.bidir).map((x) => x.n));
  const pads = Array.from({ length: d.facts.outputs }, (_, i) => i + 1);
  const onPad = (n: number) => p.surfaces.find((s) => s.output === n) ?? p.motors.find((m) => m.output === n);
  const dshotGroups = new Set(p.motors.filter((m) => m.output && m.protocol !== "PWM").map((m) => groupOf(m.output!)).filter((g) => g >= 0));
  const unplugged = [...p.surfaces.filter((s) => !s.output).map((s) => ({ type: "surface" as const, id: s.id, name: s.name })),
    ...p.motors.filter((m) => !m.output).map((m) => ({ type: "motor" as const, id: m.id, name: m.name }))];

  function why(thing: NonNullable<Sel>, n: number): string | undefined {
    const g = groupOf(n);
    const isMotor = thing.type === "motor";
    const mo = isMotor ? p.motors.find((m) => m.id === thing.id) : undefined;
    if (!isMotor && dshotGroups.has(g)) {
      const owner = p.motors.find((m) => m.output && groupOf(m.output) === g && m.protocol !== "PWM");
      if (owner && owner.output !== n) return `S${n} shares a hardware timer with ${owner.name} (DShot on S${owner.output}), so it can't drive a servo.`;
    }
    if (mo && mo.protocol !== "PWM" && g >= 0) {
      const servoHere = groups![g]!.map((o) => p.surfaces.find((s) => s.output === o)).find(Boolean);
      if (servoHere) return `${servoHere.name} is in the same timer group (S${servoHere.output}), and a DShot motor would take over the whole group. Move ${servoHere.name} first.`;
    }
    if (mo?.bidir && bidir.size && !bidir.has(n)) return `S${n} can't do bidirectional DShot on this board.`;
    return undefined;
  }
  function put(thing: NonNullable<Sel>, n: number) {
    const w = why(thing, n);
    if (w) { setMsg(w); return; }
    setMsg(undefined);
    assignOutput(thing, n);
  }

  /** What drives a surface: ArduPilot's own function, or the script (with its fallback). */
  function driver(t: Surface | Motor): string {
    if ("protocol" in t) return t.protocol === "PWM" ? "motor · PWM" : `motor · ${t.protocol}${t.bidir ? " bidir" : ""}`;
    if (t.kind === "fixed") return `function ${t.fixedFunction ?? "?"}`;
    const nat = nativeFunction(t, p);
    return nat ? nat.label : `script · else ${fallbackFunction(t, p).label}`;
  }
  const drag = (e: DragEvent, type: "surface" | "motor", id: string) => e.dataTransfer.setData(MIME_THING, JSON.stringify({ type, id }));
  const accepts = (e: DragEvent) => { if (e.dataTransfer.types.includes(MIME_THING)) e.preventDefault(); };

  return (
    <div className="board">
      <div className="row tight"><h3>Board outputs</h3>
        <span className="muted">{groups ? "Border = timer group" : "Timer layout unknown"}<Help docs={["dshot"]}>Outputs on one hardware timer must use the same signal type. A DShot motor locks its whole group for servos. Pads in one group share a border style and are spaced apart from the next group. ⚡ = can do bidirectional DShot. Empty pads are turned off.</Help></span></div>
      <div className="board-body">
        <div className="pad-list">
          {pads.map((n, i) => {
            const t = onPad(n);
            const g = groupOf(n);
            const newGroup = i > 0 && g !== groupOf(n - 1);
            const locked = dshotGroups.has(g) && !(t && "protocol" in t);
            const type = t && "protocol" in t ? "motor" : "surface";
            return (
              <div key={n} className={`pad-row ${newGroup ? "gstart" : ""} ${t && sel?.id === t.id ? "sel" : ""}`}
                onDragOver={accepts}
                onDrop={(e) => { const raw = e.dataTransfer.getData(MIME_THING); if (raw) { e.preventDefault(); put(JSON.parse(raw) as NonNullable<Sel>, n); } }}
                onClick={() => { if (t) setSel({ type, id: t.id }); else if (sel) put(sel, n); }}>
                <div className={`pad ${g >= 0 ? GROUP_CLASS[g % 8] : ""} ${locked && !t ? "locked" : ""}`}
                  title={locked && !t ? "Locked: shares a timer with a DShot motor" : `Output S${n}`}>
                  S{n}{bidir.has(n) && <span className="bolt">⚡</span>}
                </div>
                {t ? (
                  <div className="pad-thing" draggable onDragStart={(e) => drag(e, type, t.id)} title="Drag to another pad, or to Not plugged in">
                    <span className="pad-name">{t.name}</span>
                    <span className="pad-fn muted">{driver(t)}</span>
                    <Bar value={servo[n - 1] ?? 0} />
                    <span className="pad-pwm mono">{servo[n - 1] || "—"}</span>
                    <button className="small link" title="Unplug" onClick={(e) => { e.stopPropagation(); assignOutput({ type, id: t.id }, undefined); }}>×</button>
                  </div>
                ) : (
                  <div className={`pad-empty ${locked ? "bad-text" : "muted"}`} title={!locked && sel ? "Click to put the selected item here" : undefined}>
                    {locked ? "locked by DShot timer" : "free"}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="tray-box" onDragOver={accepts}
          onDrop={(e) => { const raw = e.dataTransfer.getData(MIME_THING); if (raw) { e.preventDefault(); assignOutput(JSON.parse(raw) as NonNullable<Sel>, undefined); } }}>
          <h3>Not plugged in</h3>
          {unplugged.length === 0
            ? <p className="muted">Everything is on a pad.</p>
            : unplugged.map((u) => (
              <div key={u.id} className={`tray-item ${sel?.id === u.id ? "sel" : ""}`} draggable
                onDragStart={(e) => drag(e, u.type, u.id)}
                onClick={() => setSel({ type: u.type, id: u.id })}><span>{u.name}</span><span className="muted">{u.type}</span></div>
            ))}
          <p className="muted small-text">Drag onto a pad, or select one and click a free pad. Drop a pad's item here to unplug it.</p>
        </div>
      </div>
    </div>
  );
}


