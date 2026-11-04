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
      <h1>Connect your flight controller</h1>
      <ol className="steps">
        <li><strong>Remove the propeller.</strong> Nothing on this page spins the motor, but other pages can.</li>
        <li>Plug the flight controller into this computer with USB.</li>
        <li>Click <em>Connect USB</em> and pick the port named <em>ArduPilot</em> (if there are two, pick the MAVLink one).</li>
      </ol>
      <p className="muted">Before anything can be changed, the tool reads every setting from the board and saves a backup on this computer.</p>

      <div className="row">
        <button className="primary big" disabled={busy || !hasSerial} onClick={() => void usb()}>Connect USB</button>
        {busy && <span className="muted">{s.busy?.label ?? "Working…"}</span>}
      </div>
      {!hasSerial && <p className="warn-box">This browser can't talk to USB devices. Use Google Chrome or Microsoft Edge, or the desktop app.</p>}
      {(err || s.phase === "error") && <p className="error-box">{err ?? s.error}</p>}

      <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced: simulator / bridge</summary>
        <p className="muted">Connect through <code>tools/bridge.ts</code> to ArduPilot's simulator (SITL) or to a serial port.</p>
        <div className="row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} size={28} />
          <button disabled={busy} onClick={() => void bridge()}>Connect bridge</button>
        </div>
      </details>
    </div>
  );
}
