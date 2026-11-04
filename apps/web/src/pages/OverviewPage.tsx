import { session, useMetadata, useSession } from "../state.ts";

/** Known boot/status messages that mean something the team must fix. */
const PROBLEMS: { re: RegExp; title: string; fix: string }[] = [
  { re: /log directory.*ENOSPC|ENOSPC/i, title: "SD card can't be written", fix: "The card is full or missing. Flights won't be logged and scripts can't be installed. Replace or reformat the card (FAT32)." },
  { re: /No SD card|SD card.*(not|fail)/i, title: "No SD card", fix: "Insert a FAT32 SD card. It's needed for logs and scripts." },
  { re: /PreArm: /i, title: "ArduPilot pre-arm message", fix: "See the message text." },
];

export function OverviewPage() {
  const s = useSession();
  const meta = useMetadata();
  const info = s.info!;
  const found = PROBLEMS.map((p) => ({ ...p, lines: s.log.filter((l) => p.re.test(l.text)) })).filter((p) => p.lines.length);

  return (
    <div className="page">
      <h1>{info.target ?? `Board ${info.boardId}`}</h1>
      <div className="cards">
        <div className="card">
          <h3>Board</h3>
          <dl>
            <dt>Firmware</dt><dd>ArduPlane {info.firmware} ({info.firmwareType}) <code>{info.git}</code></dd>
            <dt>Board ID</dt><dd>{info.boardId}</dd>
            <dt>Unique ID</dt><dd><code>{info.uid}</code></dd>
            <dt>Link</dt><dd>{s.link}</dd>
            <dt>Parameters</dt><dd>{session.params.size}</dd>
          </dl>
        </div>
        <div className="card">
          <h3>Backup</h3>
          {s.backup ? (
            <p>Saved {new Date(s.backup.savedAt).toLocaleString()}: {s.backup.params.length} parameters. Download or restore under Backups.</p>
          ) : <p className="warn-box">No backup yet. Editing is locked.</p>}
          <h3>Parameter docs</h3>
          {meta ? (
            <p>{meta.quality === "exact" ? "Exact match" : meta.quality === "minor" ? "Close match" : "Best guess"} for this firmware: docs from ArduPlane {meta.set.version}.
              {meta.quality !== "exact" && <span className="warn-box"> Ranges and options may differ slightly from your firmware.</span>}</p>
          ) : <p className="muted">Loading…</p>}
        </div>
      </div>

      {found.length > 0 && (
        <div className="card">
          <h3>Problems the board reported</h3>
          {found.map((p) => (
            <div key={p.title} className="problem">
              <strong>{p.title}</strong>
              <p>{p.fix}</p>
              <code className="muted">{p.lines.at(-1)!.text}</code>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Messages from the board</h3>
        <div className="log">
          {s.log.length === 0 && <span className="muted">none yet</span>}
          {[...s.log].reverse().map((l, i) => (
            <div key={i} className={`sev${Math.min(l.severity, 6)}`}>
              <span className="muted">{new Date(l.t).toLocaleTimeString()}</span> {l.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
