/**
 * Peripherals: which device is on which serial port (like Betaflight's Ports tab), sensors the
 * board found by itself, and "find it" probes that try each free port until the device answers.
 */
import { useRef, useState } from "react";
import {
  PERIPHERALS, PROTOCOL_TO_KIND, describeDev, foundSensors, padLabel, profilePorts,
  type PeripheralKind, type Profile,
} from "@husky/profile";
import { session, useSession } from "../state.ts";
import { StepShell, sleep, useLive } from "./common.tsx";
import { boardMap, updateProfile, type Derived } from "./store.ts";

const BAUDS: [number, string][] = [[9, "9600"], [19, "19200"], [38, "38400"], [57, "57600"], [115, "115200"], [230, "230400"], [460, "460800"], [921, "921600"]];
const KIND_ORDER: PeripheralKind[] = ["none", "rc-elrs", "rc", "rc-mavlink", "mavlink", "gps", "esc-telem", "displayport", "scripting"];

interface Probe { kind: "gps" | "rc-elrs"; port?: number; tried: number[]; status: string; done?: boolean }

export function PeripheralsStep({ p, d }: { p: Profile; d: Derived }) {
  const s = useSession();
  const live = useLive();
  const [probe, setProbe] = useState<Probe>();
  const cancel = useRef(false);
  const order = session.hwdef?.serialOrder;
  const ports = profilePorts(p);
  const portNums = [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => d.board.has(`SERIAL${n}_PROTOCOL`));
  const now = (n: number) => d.board.get(`SERIAL${n}_PROTOCOL`) ?? -1;
  const setPort = (n: number, kind: PeripheralKind) =>
    updateProfile((x) => {
      const next: Record<string, PeripheralKind> = { ...profilePorts(x), [n]: kind };
      // only one RC receiver: picking one turns the others off
      if (kind.startsWith("rc")) for (const [k, v] of Object.entries(next)) if (Number(k) !== n && v.startsWith("rc")) next[k] = "none";
      const portBaud = { ...(x.portBaud ?? {}) };
      delete portBaud[n];
      return { ...x, ports: next, portBaud };
    });
  const setBaud = (n: number, b: number) => updateProfile((x) => ({ ...x, ports: profilePorts(x), portBaud: { ...(x.portBaud ?? {}), [n]: b } }));

  const gpsOk = live.gps && Date.now() - live.gps.t < 3000 && live.gps.fix >= 1;
  const rcOk = live.rcCount > 0 && live.rc.slice(0, 4).some((v) => v > 800);
  const escOk = live.escT !== undefined && Date.now() - live.escT < 3000;
  const firstGps = portNums.find((n) => (ports[n] === "gps") || ((ports[n] ?? "keep") === "keep" && now(n) === 5));
  function status(kind: PeripheralKind, n?: number): string {
    if (kind === "gps" && n !== firstGps) return d.board.get("GPS2_TYPE") ? "second GPS" : "second GPS port, but GPS 2 is turned off (GPS2_TYPE)";
    if (kind === "gps") return gpsOk ? `✓ ${live.gps!.fix >= 3 ? "3D fix" : live.gps!.fix === 2 ? "2D fix" : "found, no fix yet"}, ${live.gps!.sats} satellites` : "no GPS data";
    if (kind.startsWith("rc")) return rcOk ? `✓ ${live.rcCount} channels arriving` : "no RC signal (transmitter on?)";
    if (kind === "esc-telem") return escOk ? "✓ ESC data arriving" : "no ESC data (needs battery power)";
    return "";
  }

  async function find(kind: Probe["kind"]) {
    const proto = PERIPHERALS[kind].protocol;
    const candidates = portNums.filter((n) => now(n) === -1);
    if (!candidates.length) { setProbe({ kind, tried: [], status: "No free ports to try: set unused ports to Nothing first.", done: true }); return; }
    if (!confirm(`Try each free port (${candidates.map((n) => `SERIAL${n}`).join(", ")}) until the ${kind === "gps" ? "GPS" : "receiver"} answers?\n\nThe board reboots once per port (about 10 s each).${kind !== "gps" ? " Keep the transmitter on." : ""}`)) return;
    cancel.current = false;
    const tried: number[] = [];
    try {
      for (const n of candidates) {
        if (cancel.current) break;
        setProbe({ kind, tried, status: `Trying SERIAL${n} ${padLabel(n, order)}…` });
        const w = await session.write([{ name: `SERIAL${n}_PROTOCOL`, value: proto }], `Try SERIAL${n}`);
        if (!w.ok) throw new Error(w.aborted ?? "write refused");
        await session.rebootAndReconnect(`Trying SERIAL${n}`);
        const t0 = Date.now();
        let found = false;
        while (Date.now() - t0 < (kind === "gps" ? 9000 : 5000) && !cancel.current) {
          await sleep(500);
          const l = session.live;
          found = kind === "gps" ? !!l.gps && l.gps.fix >= 1 && Date.now() - l.gps.t < 2000 : l.rcCount > 0;
          if (found) break;
        }
        tried.push(n);
        if (found) {
          setPort(n, kind);
          setProbe({ kind, port: n, tried, status: `Found it on SERIAL${n} ${padLabel(n, order)}.`, done: true });
          return;
        }
        await session.write([{ name: `SERIAL${n}_PROTOCOL`, value: -1 }], `Not on SERIAL${n}`);
      }
      setProbe({ kind, tried, status: cancel.current ? "Stopped." : "Not found on any free port. Check the wiring (TX↔RX crossed) and power.", done: true });
      await session.rebootAndReconnect("Restoring ports");
    } catch (e) {
      setProbe({ kind, tried, status: `Stopped: ${(e as Error).message}`, done: true });
    }
  }

  const sensors = foundSensors(boardMap());
  const busy = !!probe && !probe.done;
  return (
    <StepShell title="Peripherals" d={d} steps={["receiver"]}
      intro={<p>What's plugged into each serial port. ArduPilot only recognizes a device on a port that's set to the right type, so if you don't know which pads something is on, use <em>Find</em>: it tries each free port in turn.</p>}>
      <table className="grid ports">
        <thead><tr><th>Port</th><th>Pads</th><th>Device</th><th>Speed</th><th>On the board now</th><th>Status</th></tr></thead>
        <tbody>{portNums.map((n) => {
          const kind = ports[n] ?? "keep";
          const eff = kind === "keep" ? PROTOCOL_TO_KIND[now(n)] ?? "keep" : kind;
          const info = eff !== "keep" ? PERIPHERALS[eff] : undefined;
          const baud = p.portBaud?.[n] ?? (kind === "keep" ? d.board.get(`SERIAL${n}_BAUD`) : info?.baud);
          return (
            <tr key={n}>
              <td className="mono">SERIAL{n}</td>
              <td>{padLabel(n, order) || <span className="muted">—</span>}</td>
              <td><select value={kind} disabled={busy} onChange={(e) => setPort(n, e.target.value as PeripheralKind)}>
                <option value="keep">leave as it is</option>
                {KIND_ORDER.map((k) => <option key={k} value={k}>{PERIPHERALS[k as Exclude<PeripheralKind, "keep">].label}</option>)}
              </select>{info && kind !== "keep" && <div className="muted small-text">{info.help}</div>}</td>
              <td>{info?.baud !== undefined && eff !== "rc" && eff !== "rc-elrs"
                ? <select value={baud ?? info.baud} disabled={busy || kind === "keep"} onChange={(e) => setBaud(n, Number(e.target.value))}>
                    {BAUDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                : <span className="muted">{eff.startsWith("rc") ? "automatic" : "—"}</span>}</td>
              <td className="muted">{PERIPHERALS[(PROTOCOL_TO_KIND[now(n)] ?? "none") as Exclude<PeripheralKind, "keep">]?.label ?? `protocol ${now(n)}`}</td>
              <td>{status(eff, n)}</td>
            </tr>
          );
        })}</tbody>
      </table>

      <div className="card">
        <h3>Find a device</h3>
        <p className="muted">Board disarmed, propeller off. Each try is one reboot. Only ports set to Nothing are tried, and they're put back if the device isn't there.</p>
        <div className="row">
          <button disabled={busy || !session.canWrite} onClick={() => void find("gps")}>Find my GPS</button>
          <button disabled={busy || !session.canWrite || rcOk} title={rcOk ? "RC is already arriving" : ""} onClick={() => void find("rc-elrs")}>Find my receiver</button>
          {busy && <button onClick={() => { cancel.current = true; }}>Stop</button>}
        </div>
        {probe && <p className={probe.port ? "ok-box" : probe.done ? "warn-box" : "muted"}>{probe.status}{probe.tried.length > 0 && !probe.port ? ` (tried ${probe.tried.map((n) => `SERIAL${n}`).join(", ")})` : ""}</p>}
        {s.busy && busy && <p className="muted">{s.busy.label}…</p>}
      </div>

      <div className="card">
        <h3>Sensors the board found by itself</h3>
        <p className="muted">I2C and SPI sensors are detected at every boot; nothing to configure here.</p>
        {sensors.length === 0 ? <p className="muted">None reported.</p> : (
          <table className="grid compact"><tbody>{sensors.map((x) => (
            <tr key={x.param}><td>{x.role}</td><td>{describeDev(x.dev)}</td>
              <td className="muted">{x.enabled === false ? "found but not used" : ""}</td></tr>
          ))}</tbody></table>
        )}
      </div>
    </StepShell>
  );
}
