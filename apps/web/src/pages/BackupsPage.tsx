import { useEffect, useMemo, useState } from "react";
import { parseParamFile, toParamFile, type BackupRecord } from "@husky/vehicle";
import { describeValue } from "@husky/metadata";
import { downloadText, session, useMetadata, useSession } from "../state.ts";
import { Review, type ReviewItem } from "../components/Review.tsx";

/** Never restored: counters, versions and other values the board manages itself. */
const NEVER = /^(STAT_|FORMAT_VERSION$|SYSID_SW_|INS_.*_ID$|COMPASS_DEV_ID|BARO\d?_DEVID|ARSPD\d?_DEVID|.*_DEVID\d?$)/;

interface Source { label: string; params: { name: string; value: number }[]; boardUid?: string; savedAt?: string }

export function BackupsPage() {
  const s = useSession();
  const meta = useMetadata();
  const [list, setList] = useState<BackupRecord[]>([]);
  const [source, setSource] = useState<Source>();
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [msg, setMsg] = useState<string>();

  const refresh = () => void session.listBackups().then(setList);
  useEffect(refresh, [s.backup?.id]);

  const diff = useMemo(() => {
    if (!source) return [];
    return source.params
      .filter((p) => session.params.has(p.name) && !NEVER.test(p.name) && !meta?.set.params[p.name]?.ro)
      .filter((p) => Math.fround(p.value) !== Math.fround(session.params.get(p.name)!.value))
      .map((p) => ({ name: p.name, value: p.value, from: session.params.get(p.name)!.value }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, s.paramsRev, meta]);
  const otherBoard = !!source?.boardUid && source.boardUid !== s.info?.uid;
  const unknown = source ? source.params.filter((p) => !session.params.has(p.name)).length : 0;

  function choose(src: Source) {
    setSource(src);
    setMsg(undefined);
    // Calibration values belong to the physical board they were measured on.
    const cal = src.params.filter((p) => meta?.set.params[p.name]?.cal).map((p) => p.name);
    setSkip(new Set(src.boardUid && src.boardUid === s.info?.uid ? [] : cal));
  }

  async function loadFile(f: File) {
    const params = parseParamFile(await f.text());
    if (!params.length) { setMsg(`${f.name} has no parameters in it`); return; }
    choose({ label: f.name, params });
  }

  async function backupNow() {
    await session.downloadParams();
    await session.saveBackup("manual");
    refresh();
  }

  const items: ReviewItem[] = diff.filter((d) => !skip.has(d.name));

  if (reviewing && source) {
    return (
      <div className="page">
        <Review items={items} meta={meta} title={`Restore from ${source.label}`}
          onCancel={() => setReviewing(false)}
          onDone={() => { setReviewing(false); setSource(undefined); }} />
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Backups</h1>
      <p className="muted">A full backup is saved automatically every time you connect. Backups are kept in this browser on this computer, so download the important ones.</p>
      <div className="toolbar">
        <button disabled={s.phase !== "ready" || !!s.busy} onClick={() => void backupNow()}>Back up now</button>
        <label className="file-btn">Restore from a .param file…
          <input type="file" accept=".param,.parm,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadFile(f); e.target.value = ""; }} />
        </label>
      </div>
      {msg && <p className="error-box">{msg}</p>}

      <table className="grid">
        <thead><tr><th>Saved</th><th>Why</th><th>Board</th><th>Params</th><th></th></tr></thead>
        <tbody>
          {list.map((b) => (
            <tr key={b.id} className={source?.label === b.id ? "changed-row" : ""}>
              <td>{new Date(b.savedAt).toLocaleString()}</td>
              <td>{b.reason}</td>
              <td>{b.target} · fw {b.firmware}</td>
              <td>{b.params.length}</td>
              <td className="row">
                <button className="small" onClick={() => downloadText(`${b.target}-${b.savedAt.replace(/[:.]/g, "-")}.param`, toParamFile(b))}>Download .param</button>
                <button className="small" onClick={() => choose({ label: b.id, params: b.params, boardUid: b.boardUid, savedAt: b.savedAt })}>Compare / restore</button>
              </td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={5} className="muted">No backups for this board yet.</td></tr>}
        </tbody>
      </table>

      {source && (
        <div className="card">
          <h3>Compared with the board now: {source.savedAt ? new Date(source.savedAt).toLocaleString() : source.label}</h3>
          {otherBoard && <p className="warn-box">This backup came from a different flight controller. Its calibration values are unticked, because they belong to that board.</p>}
          {!source.boardUid && <p className="warn-box">This file doesn't say which board it came from. Calibration values are unticked. Tick them only if it's from this board.</p>}
          {unknown > 0 && <p className="muted">{unknown} setting{unknown === 1 ? "" : "s"} in the backup don't exist on this firmware and are ignored.</p>}
          {diff.length === 0 ? <p>No differences. The board already matches this backup.</p> : (
            <>
              <table className="grid">
                <thead><tr><th></th><th>Setting</th><th>Board now</th><th>Backup</th></tr></thead>
                <tbody>{diff.map((d) => {
                  const m = meta?.set.params[d.name];
                  return (
                    <tr key={d.name}>
                      <td><input type="checkbox" checked={!skip.has(d.name)} onChange={(e) => {
                        const n = new Set(skip); if (e.target.checked) n.delete(d.name); else n.add(d.name); setSkip(n);
                      }} /></td>
                      <td><strong>{m?.n ?? d.name}</strong> <span className="muted mono">{d.name}</span>{m?.cal && <span className="tag">calibration</span>}</td>
                      <td>{describeValue(m, d.from)}</td>
                      <td>{describeValue(m, d.value)}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
              <div className="row">
                <button className="primary" disabled={items.length === 0} onClick={() => setReviewing(true)}>Review restoring {items.length} setting{items.length === 1 ? "" : "s"}</button>
                <button onClick={() => setSource(undefined)}>Close</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
