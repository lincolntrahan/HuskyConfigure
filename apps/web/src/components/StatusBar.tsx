import { session, useSession, PLANE_MODES } from "../state.ts";

const PHASE_LABEL: Record<string, string> = {
  disconnected: "Not connected", connecting: "Connecting…", identifying: "Identifying board…",
  downloading: "Reading parameters…", "backing-up": "Saving backup…", ready: "Connected",
  lost: "Link lost", error: "Connection failed",
};

export function StatusBar() {
  const s = useSession();
  const pct = s.busy && s.busy.total ? Math.round((100 * s.busy.done) / s.busy.total) : undefined;
  return (
    <header className={`status ${s.armed ? "armed" : ""} ${s.phase === "lost" ? "lost" : ""}`}>
      <span className={`dot ${s.phase}`} />
      <strong>{PHASE_LABEL[s.phase] ?? s.phase}</strong>
      {s.info && (
        <>
          <span className="sep" />
          <span title={`APJ board id ${s.info.boardId}, uid ${s.info.uid}`}>{s.info.target ?? `board ${s.info.boardId}`}</span>
          <span className="muted">ArduPlane {s.info.firmware}{s.info.firmwareType !== "official" ? ` ${s.info.firmwareType}` : ""}</span>
          <span className="sep" />
          <span className="muted">mode</span> <span>{PLANE_MODES[s.mode] ?? s.mode}</span>
          <span className={`badge ${s.armed ? "bad" : "good"}`}>{s.armed ? "ARMED: editing locked" : "disarmed"}</span>
          <span className={`badge ${s.backup ? "good" : "warn"}`} title={s.backup ? `Backup saved ${new Date(s.backup.savedAt).toLocaleString()}` : undefined}>
            {s.backup ? "backup saved" : "no backup yet"}
          </span>
        </>
      )}
      {s.busy && (
        <span className="busy">
          {s.busy.label}{pct !== undefined ? ` ${pct}%` : ""}
          <span className="bar"><span style={{ width: `${pct ?? 0}%` }} /></span>
        </span>
      )}
      <span className="spacer" />
      {s.rebootNeeded.length > 0 && !s.armed && (
        <button className="small warn" title={`Changed: ${s.rebootNeeded.join(", ")}`}
          onClick={() => { void session.reboot(); }}>
          Reboot needed ({s.rebootNeeded.length}): reboot now
        </button>
      )}
      {s.phase !== "disconnected" && s.phase !== "error" && (
        <button className="small" onClick={() => void session.disconnect()}>Disconnect</button>
      )}
    </header>
  );
}
