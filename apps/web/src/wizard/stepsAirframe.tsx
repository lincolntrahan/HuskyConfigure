import { useState } from "react";
import {
  S, TEMPLATES, motor, spoilerInput, nativeFunction, fallbackFunction,
  type CustomInput, type MixTerm, type Motor, type Profile, type Surface, type SurfaceKind,
} from "@husky/profile";
import huskyLua from "../../../../scripts/husky.lua?raw";
import { session, useSession } from "../state.ts";
import { StepShell, useLive } from "./common.tsx";
import { updateProfile, type Derived } from "./store.ts";

const KINDS: SurfaceKind[] = ["aileron", "elevator", "rudder", "flap", "spoiler", "elevon", "ruddervator", "flaperon", "spoileron", "steering", "mechanism", "fixed"];
const ADD: { label: string; make: () => Surface }[] = [
  { label: "Left aileron", make: S.aileronL }, { label: "Right aileron", make: S.aileronR },
  { label: "Elevator", make: S.elevator }, { label: "Rudder", make: S.rudder }, { label: "Tailwheel steering", make: S.steering },
  { label: "Left ruddervator", make: S.ruddervatorL }, { label: "Right ruddervator", make: S.ruddervatorR },
  { label: "Left elevon", make: S.elevonL }, { label: "Right elevon", make: S.elevonR },
  { label: "Left flaperon", make: S.flaperonL }, { label: "Right flaperon", make: S.flaperonR },
  { label: "Left flap", make: S.flapL }, { label: "Right flap", make: S.flapR },
  { label: "Left spoiler", make: S.spoilerL }, { label: "Right spoiler", make: S.spoilerR },
  { label: "Left spoileron", make: S.spoileronL }, { label: "Right spoileron", make: S.spoileronR },
  { label: "Mechanism / payload (RC passthrough)", make: () => S.mechanism(9) },
];

const editSurface = (id: string, fn: (s: Surface) => Surface) =>
  updateProfile((x) => ({ ...x, surfaces: x.surfaces.map((s) => (s.id === id ? fn(s) : s)) }));

function inputOptions(p: Profile) {
  return [
    ["roll", "Roll"], ["pitch", "Pitch"], ["yaw", "Yaw"], ["flap", "Flap"], ["throttle", "Throttle"],
    ...p.inputs.map((i) => [i.id, `${i.label} (RC${i.rc})`]),
    ...Array.from({ length: 16 }, (_, k) => [`rc${k + 1}`, `RC channel ${k + 1} (raw)`]),
  ] as [string, string][];
}

// ---------------- Airframe ----------------
export function AirframeStep({ p, d }: { p: Profile; d: Derived }) {
  const [adding, setAdding] = useState("");
  const usesFlap = p.surfaces.some((s) => s.mix.some((t) => t.in === "flap"));
  const usesInputs = new Set(p.surfaces.flatMap((s) => s.mix.map((t) => t.in)));

  function applyTemplate(id: string) {
    const t = TEMPLATES.find((x) => x.id === id)!;
    if (p.surfaces.length && !confirm(`Replace the ${p.surfaces.length} surfaces you have with the "${t.label}" template?`)) return;
    updateProfile((x) => ({
      ...x,
      surfaces: t.surfaces(),
      inputs: t.needsSpoilerInput && !x.inputs.some((i) => i.id === "spoiler") ? [...x.inputs, spoilerInput(7)] : x.inputs,
      motors: x.motors.length ? x.motors : [motor()],
    }));
  }

  return (
    <StepShell title="Airframe" d={d}
      intro={<p>Describe each moving surface and what moves it. A surface can mix several inputs: a spoileron is roll + spoiler. Signs: <strong>+ moves the trailing edge up</strong> (or right, for a rudder). Which way the servo turns is sorted out later by the direction check, so don't worry about servo direction here.</p>}>
      <div className="row">
        <span>Start from a template:</span>
        {TEMPLATES.map((t) => <button key={t.id} title={t.description} onClick={() => applyTemplate(t.id)}>{t.label}</button>)}
      </div>

      <h3>Surfaces</h3>
      {p.surfaces.length === 0 && <p className="muted">No surfaces yet. Pick a template or add them one by one.</p>}
      <div className="surfaces">
        {p.surfaces.map((s) => <SurfaceCard key={s.id} s={s} p={p} />)}
      </div>
      <div className="row">
        <select value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">Add a surface…</option>
          {ADD.map((a) => <option key={a.label} value={a.label}>{a.label}</option>)}
        </select>
        <button disabled={!adding} onClick={() => {
          const a = ADD.find((x) => x.label === adding)!;
          updateProfile((x) => ({ ...x, surfaces: [...x.surfaces, a.make()], inputs: a.label.includes("spoiler") && !x.inputs.some((i) => i.id === "spoiler") ? [...x.inputs, spoilerInput(7)] : x.inputs }));
          setAdding("");
        }}>Add</button>
      </div>

      <h3>Extra inputs</h3>
      <p className="muted">Switches or sliders on the transmitter that drive surfaces directly (spoilers, payload release…).</p>
      {p.inputs.map((inp) => <InputRow key={inp.id} inp={inp} used={usesInputs.has(inp.id)} />)}
      <button onClick={() => updateProfile((x) => ({ ...x, inputs: [...x.inputs, { id: `input${x.inputs.length + 1}`, label: "New input", rc: 9, range: "unipolar" }] }))}>Add input</button>
      {usesFlap && (
        <label className="field inline">Flap input channel
          <select value={p.flapChannel ?? ""} onChange={(e) => updateProfile((x) => ({ ...x, flapChannel: e.target.value ? Number(e.target.value) : undefined }))}>
            <option value="">choose…</option>
            {Array.from({ length: 12 }, (_, i) => i + 5).map((c) => <option key={c} value={c}>RC{c}</option>)}
          </select>
        </label>
      )}

      <h3>Motors</h3>
      {p.motors.map((m) => (
        <div key={m.id} className="row">
          <input value={m.name} onChange={(e) => editMotor(m.id, { name: e.target.value })} />
          <select value={m.position} onChange={(e) => editMotor(m.id, { position: e.target.value as Motor["position"] })}>
            <option value="center">single / center</option><option value="left">left (twin)</option><option value="right">right (twin)</option>
          </select>
          <button className="small" onClick={() => updateProfile((x) => ({ ...x, motors: x.motors.filter((y) => y.id !== m.id) }))}>Remove</button>
        </div>
      ))}
      <button onClick={() => updateProfile((x) => ({ ...x, motors: [...x.motors, motor()] }))}>Add motor</button>
    </StepShell>
  );
}

const editMotor = (id: string, patch: Partial<Motor>) =>
  updateProfile((x) => ({ ...x, motors: x.motors.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));

function SurfaceCard({ s, p }: { s: Surface; p: Profile }) {
  const nat = nativeFunction(s, p);
  const fb = !nat && s.kind !== "fixed" ? fallbackFunction(s, p) : undefined;
  const setTerm = (k: number, t: Partial<MixTerm>) => editSurface(s.id, (x) => ({ ...x, mix: x.mix.map((m, i) => (i === k ? { ...m, ...t } : m)) }));
  return (
    <div className="card surface">
      <div className="row">
        <input className="name" value={s.name} onChange={(e) => editSurface(s.id, (x) => ({ ...x, name: e.target.value }))} />
        <select value={s.kind} onChange={(e) => editSurface(s.id, (x) => ({ ...x, kind: e.target.value as SurfaceKind }))}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select value={s.side ?? "center"} onChange={(e) => editSurface(s.id, (x) => ({ ...x, side: e.target.value as Surface["side"] }))}>
          <option value="left">left</option><option value="center">center</option><option value="right">right</option>
        </select>
        <span className="spacer" />
        <button className="small" onClick={() => updateProfile((x) => ({ ...x, surfaces: x.surfaces.filter((y) => y.id !== s.id) }))}>Remove</button>
      </div>
      {s.kind === "fixed" ? (
        <p className="muted">Fixed ArduPilot output function {s.fixedFunction} (kept as is).</p>
      ) : (
        <>
          <table className="mix"><tbody>
            {s.mix.map((t, k) => (
              <tr key={k}>
                <td><select value={t.in} onChange={(e) => setTerm(k, { in: e.target.value })}>
                  {inputOptions(p).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></td>
                <td>× <input className="num short" type="number" step={0.05} min={-1} max={1} value={t.w} onChange={(e) => setTerm(k, { w: Math.max(-1, Math.min(1, Number(e.target.value))) })} /></td>
                <td><select value={t.curve ?? "linear"} onChange={(e) => setTerm(k, { curve: e.target.value as MixTerm["curve"] })}>
                  <option value="linear">both ways</option><option value="positive">only when it pushes up/right</option><option value="negative">only when it pushes down/left</option>
                </select></td>
                <td><button className="small" onClick={() => editSurface(s.id, (x) => ({ ...x, mix: x.mix.filter((_, i) => i !== k) }))}>×</button></td>
              </tr>
            ))}
          </tbody></table>
          <div className="row">
            {s.mix.length < 3 && <button className="small" onClick={() => editSurface(s.id, (x) => ({ ...x, mix: [...x.mix, { in: "roll", w: 1 }] }))}>+ input</button>}
            <span className={nat ? "tag good" : "tag warn"}>
              {nat ? `ArduPilot native: ${nat.label}` : `Mixed by the companion script${fb ? `; if the script stops it acts as ${fb.label}` : ""}`}
            </span>
          </div>
        </>
      )}
      {(s.kind === "mechanism" || s.kind === "fixed") && (
        <label className="field inline">During RC-loss failsafe
          <select value={s.failsafe ?? "hold"} onChange={(e) => editSurface(s.id, (x) => ({ ...x, failsafe: e.target.value as Surface["failsafe"] }))}>
            <option value="hold">stay where it is</option><option value="trim">go to center</option><option value="min">go to low end</option><option value="max">go to high end</option>
          </select>
        </label>
      )}
    </div>
  );
}

function InputRow({ inp, used }: { inp: CustomInput; used: boolean }) {
  const edit = (patch: Partial<CustomInput>) => updateProfile((x) => ({ ...x, inputs: x.inputs.map((i) => (i.id === inp.id ? { ...i, ...patch } : i)) }));
  return (
    <div className="row">
      <input value={inp.label} onChange={(e) => edit({ label: e.target.value })} />
      <span>on</span>
      <select value={inp.rc} onChange={(e) => edit({ rc: Number(e.target.value) })}>
        {Array.from({ length: 16 }, (_, i) => i + 1).map((c) => <option key={c} value={c}>RC{c}</option>)}
      </select>
      <select value={inp.range} onChange={(e) => edit({ range: e.target.value as CustomInput["range"] })}>
        <option value="unipolar">off at one end, full at the other</option><option value="bipolar">centered (−/+ around the middle)</option>
      </select>
      {!used && <button className="small" onClick={() => updateProfile((x) => ({ ...x, inputs: x.inputs.filter((i) => i.id !== inp.id) }))}>Remove</button>}
    </div>
  );
}

// ---------------- Outputs ----------------
const GROUP_COLORS = ["#4d8ef0", "#d9822b", "#2ea36b", "#b55bd6", "#cc4b4b", "#3aa6a6", "#a68b2e", "#777"];

export function OutputsStep({ p, d }: { p: Profile; d: Derived }) {
  const live = useLive();
  const groups = d.facts.timerGroups;
  const groupOf = (n: number) => groups?.findIndex((g) => g.includes(n)) ?? -1;
  const bidirPins = new Set(session.hwdef?.pwm.filter((x) => x.bidir).map((x) => x.n));
  const outs = Array.from({ length: d.facts.outputs }, (_, i) => i + 1);
  const taken = (n: number, self: string) => [...p.surfaces.map((s) => [s.id, s.output] as const), ...p.motors.map((m) => [m.id, m.output] as const)].some(([id, o]) => o === n && id !== self);
  const pick = (self: string, value: number | undefined, set: (v: number | undefined) => void) => (
    <select value={value ?? ""} onChange={(e) => set(e.target.value ? Number(e.target.value) : undefined)}>
      <option value="">not plugged in</option>
      {outs.map((n) => <option key={n} value={n} disabled={taken(n, self)}>S{n}{groupOf(n) >= 0 ? ` (group ${String.fromCharCode(65 + groupOf(n))})` : ""}{taken(n, self) ? " (used)" : ""}</option>)}
    </select>
  );

  return (
    <StepShell title="Outputs" d={d} steps={["outputs", "motor"]}
      intro={<p>Which pad on the flight controller each servo and ESC is plugged into. Outputs in the same group share a hardware timer: a DShot motor's group can't drive normal servos.</p>}>
      {groups && (
        <div className="row groups">
          {groups.map((g, i) => <span key={i} className="group" style={{ borderColor: GROUP_COLORS[i % 8] }}>Group {String.fromCharCode(65 + i)}: {g.map((n) => `S${n}${bidirPins.has(n) ? "*" : ""}`).join(" ")}</span>)}
          {bidirPins.size > 0 && <span className="muted">* can do bidirectional DShot</span>}
        </div>
      )}
      {!groups && <p className="muted">This board didn't report its timer layout, so output groups can't be checked here.</p>}
      <table className="grid">
        <thead><tr><th>Thing</th><th>Output</th><th>Now on that output</th><th>Live</th></tr></thead>
        <tbody>
          {p.motors.map((m) => (
            <tr key={m.id}><td><strong>{m.name}</strong> <span className="muted">motor</span></td>
              <td>{pick(m.id, m.output, (v) => editMotor(m.id, { output: v }))}</td>
              <td className="muted">{m.output ? `function ${d.board.get(`SERVO${m.output}_FUNCTION`)}` : ""}</td>
              <td className="mono">{m.output ? live.servo[m.output - 1] : ""}</td></tr>
          ))}
          {p.surfaces.map((s) => (
            <tr key={s.id}><td><strong>{s.name}</strong> <span className="muted">{s.kind}</span></td>
              <td>{pick(s.id, s.output, (v) => editSurface(s.id, (x) => ({ ...x, output: v })))}</td>
              <td className="muted">{s.output ? `function ${d.board.get(`SERVO${s.output}_FUNCTION`)}` : ""}</td>
              <td className="mono">{s.output ? live.servo[s.output - 1] : ""}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Outputs not listed here are switched off, so nothing left over from an old setup keeps driving a servo.</p>

      {p.motors.map((m) => (
        <div key={m.id} className="card">
          <h3>{m.name}: ESC</h3>
          <div className="row">
            <label className="field inline">Signal
              <select value={m.protocol} onChange={(e) => editMotor(m.id, { protocol: e.target.value as Motor["protocol"] })}>
                <option value="PWM">PWM (normal ESC, needs calibration)</option>
                <option value="DSHOT150">DShot150 (long wires)</option><option value="DSHOT300">DShot300</option>
                <option value="DSHOT600">DShot600</option><option value="DSHOT1200">DShot1200</option>
              </select>
            </label>
            {m.protocol !== "PWM" && (
              <label className="field inline"><input type="checkbox" checked={m.bidir} onChange={(e) => editMotor(m.id, { bidir: e.target.checked, telemetry: e.target.checked ? "bidir" : m.telemetry === "bidir" ? "none" : m.telemetry })} /> bidirectional DShot (RPM on the signal wire)</label>
            )}
            <label className="field inline">ESC telemetry
              <select value={m.telemetry} onChange={(e) => editMotor(m.id, { telemetry: e.target.value as Motor["telemetry"] })}>
                <option value="none">none</option>
                {m.bidir && <option value="bidir">from bidirectional DShot</option>}
                <option value="serial">telemetry wire to a serial pad</option>
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
          </div>
        </div>
      ))}
    </StepShell>
  );
}

// ---------------- Companion script ----------------
export const BUNDLED_VERSION = Number(/local VERSION = (\d+)/.exec(huskyLua)?.[1] ?? 0);

export function ScriptStep({ d }: { p: Profile; d: Derived }) {
  const s = useSession();
  const live = useLive();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const running = live.hsk && Date.now() - live.hsk.t < 4000 ? live.hsk : undefined;
  const upToDate = running?.version === BUNDLED_VERSION;

  async function install() {
    setBusy(true); setMsg(undefined);
    try {
      const path = await session.uploadScript("husky.lua", huskyLua);
      if (d.board.get("SCR_ENABLE") !== 1) {
        const r = await session.write([{ name: "SCR_ENABLE", value: 1 }], "Enable scripting");
        if (!r.ok) throw new Error("couldn't enable scripting");
      }
      setMsg(`Uploaded to ${path}. Rebooting so it starts with its settings…`);
      await session.rebootAndReconnect("Rebooting to start the script");
      setMsg("Done. The script will report in within a few seconds. Then apply the Outputs, Failsafe and Arming steps: they have settings that only exist once the script runs.");
    } catch (e) {
      const m = (e as Error).message;
      setMsg(/errno 28|FailErrno/.test(m) ? "The board's SD card can't be written (full or missing). Replace or reformat the SD card (FAT32) and try again." : `Install failed: ${m}`);
    } finally { setBusy(false); }
  }

  return (
    <StepShell title="Companion script" d={d}
      intro={<p><code>husky.lua</code> runs on the flight controller. It holds the DBF failsafe pose when the link is lost, owns rudder-stick arming (so a missing or crashed script means the plane can't arm), and mixes surfaces ArduPilot can't (spoilerons).</p>}>
      {!d.facts.hasScripting ? (
        <p className="warn-box">This board's firmware has no Lua scripting (F4 boards). The failsafe uses ArduPilot's GLIDE, arming uses ArduPilot's own rudder arming, and scripted surfaces aren't available.</p>
      ) : (
        <>
          <p className={upToDate ? "ok-box" : "warn-box"}>
            {running ? `Running: version ${running.version}${upToDate ? " (current)" : `, but this tool has version ${BUNDLED_VERSION}`}.` : "Not running on the board."}
          </p>
          <button className="primary" disabled={busy || !session.canWrite || !!s.busy} onClick={() => void install()}>
            {running ? (upToDate ? "Reinstall" : `Update to version ${BUNDLED_VERSION}`) : "Install the companion script"}
          </button>
          {msg && <p className="muted">{msg}</p>}
          <p className="muted">Installing uploads the file to the SD card over USB, turns scripting on, and reboots the board (the tool reconnects by itself).</p>
        </>
      )}
    </StepShell>
  );
}
