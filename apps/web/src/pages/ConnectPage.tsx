import { useState } from "react";
import { requestSerialPort, webSerial, webSerialTransport, wsTransport } from "@husky/vehicle";
import { session, useSession } from "../state.ts";

export function ConnectPage() {
  const s = useSession();
  const [advanced, setAdvanced] = useState(false);
  const [url, setUrl] = useState("ws://127.0.0.1:5770");
  const [err, setErr] = useState<string>();
  const busy = !["disconnected", "error", "ready", "lost"].includes(s.phase);
  const hasSerial = !!webSerial();

  async function usb() {
    setErr(undefined);
    try {
      const port = await requestSerialPort();
      // a function, not a link: lets the session reopen the same port after a reboot
      await session.connect(() => webSerialTransport(port));
    } catch (e) {
      if ((e as Error).name !== "NotFoundError") setErr((e as Error).message); // NotFoundError = picker cancelled
    }
  }
  async function bridge() {
    setErr(undefined);
    try { await session.connect(() => wsTransport(url)); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="page narrow">
      <h1>Connect</h1>
      <ol className="steps">
        <li>Remove the propeller</li>
        <li>Plug in the flight controller by USB</li>
        <li>Connect USB, then pick the ArduPilot MAVLink port</li>
      </ol>
      <p className="muted">Every setting is backed up before anything can change.</p>

      <div className="row">
        <button className="primary big" disabled={busy || !hasSerial} onClick={() => void usb()}>Connect USB</button>
        {busy && <span className="muted">{s.busy?.label ?? "Working…"}</span>}
      </div>
      {!hasSerial && <p className="warn-box">USB needs Chrome or Edge, or the desktop app.</p>}
      {(err || s.phase === "error") && <p className="error-box">{err ?? s.error}</p>}

      <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced: simulator / bridge</summary>
        <p className="muted">Reach the simulator (SITL) or a serial port through tools/bridge.ts.</p>
        <div className="row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} size={28} />
          <button disabled={busy} onClick={() => void bridge()}>Connect bridge</button>
        </div>
      </details>
    </div>
  );
}
