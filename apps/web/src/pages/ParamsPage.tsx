import { useMemo, useState } from "react";
import { describeValue, validateValue } from "@husky/metadata";
import { session, useMetadata, useSession } from "../state.ts";
import { ValueEditor } from "../components/ValueEditor.tsx";
import { Review, type ReviewItem } from "../components/Review.tsx";
import { Help } from "../components/Help.tsx";

const LIMIT = 150;

/** Advanced: every parameter, searchable, with staged edits that go through the review screen. */
export function ParamsPage() {
  const s = useSession();
  const meta = useMetadata();
  const [q, setQ] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [staged, setStaged] = useState<Map<string, number>>(new Map());
  const [reviewing, setReviewing] = useState(false);
  const [openRow, setOpenRow] = useState<string>();
  const [resetToken, setResetToken] = useState(0); // remounts editors after "discard"

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...session.params.values()]
      .filter((p) => {
        const m = meta?.set.params[p.name];
        if (!showAdvanced && m?.adv) return false;
        if (onlyChanged && !staged.has(p.name)) return false;
        if (!needle) return true;
        return p.name.toLowerCase().includes(needle) || (m?.n ?? "").toLowerCase().includes(needle)
          || (needle.length > 3 && (m?.d ?? "").toLowerCase().includes(needle));
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.paramsRev, meta, q, showAdvanced, onlyChanged, staged]);

  const stage = (name: string, v: number) => {
    const next = new Map(staged);
    if (Math.fround(session.params.get(name)!.value) === Math.fround(v)) next.delete(name); else next.set(name, v);
    setStaged(next);
  };
  const items: ReviewItem[] = [...staged].map(([name, value]) => ({ name, value, from: session.params.get(name)?.value }));
  const invalid = items.filter((c) => validateValue(meta?.set.params[c.name], c.value).length).length;

  if (reviewing) {
    return (
      <div className="page">
        <Review items={items} meta={meta} title="Parameter changes"
          onCancel={() => setReviewing(false)}
          onDone={(r) => {
            const next = new Map(staged);
            for (const res of r.results) if (res.ok) next.delete(res.name);
            setStaged(next);
            setReviewing(false);
          }} />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>All parameters</h1>
        <span className="muted">Advanced. Use the wizard for normal setup.<Help docs={["params"]}>Every parameter on the board, with ArduPilot's own descriptions and limits for this firmware.</Help></span>
      </div>
      <div className="toolbar">
        <input autoFocus placeholder="Search name or description (e.g. SERVO3, airspeed, failsafe)" value={q} onChange={(e) => setQ(e.target.value)} />
        <label><input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} /> include advanced</label>
        <label><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> only my changes</label>
        <span className="spacer" />
        {staged.size > 0 && <button onClick={() => { setStaged(new Map()); setResetToken(resetToken + 1); }}>Discard changes</button>}
        <button className="primary" disabled={staged.size === 0 || invalid > 0} onClick={() => setReviewing(true)}>
          Review {staged.size} change{staged.size === 1 ? "" : "s"}
        </button>
      </div>
      {invalid > 0 && <p className="error-box">{invalid} change{invalid === 1 ? " has" : "s have"} an invalid value.</p>}
      <table className="grid params">
        <thead><tr><th>Name</th><th>Setting</th><th>Value</th><th>Change to</th></tr></thead>
        <tbody>
          {rows.slice(0, LIMIT).map((p) => {
            const m = meta?.set.params[p.name];
            const st = staged.get(p.name);
            const bad = st !== undefined ? validateValue(m, st) : [];
            return (
              <tr key={p.name} className={st !== undefined ? (bad.length ? "bad-row" : "changed-row") : ""}>
                <td className="mono"><button className="link" onClick={() => setOpenRow(openRow === p.name ? undefined : p.name)}>{p.name}</button></td>
                <td>
                  {m?.n ?? <span className="muted">(no description)</span>}
                  {m?.rb && <span className="tag">reboot</span>}{m?.ro && <span className="tag">read-only</span>}{m?.cal && <span className="tag">calibration</span>}
                  {openRow === p.name && (
                    <div className="desc">
                      {m?.d}
                      {m?.r && <div className="muted">Range {m.r[0]} … {m.r[1]}{m.u ? ` ${m.u}` : ""}{m.i ? `, step ${m.i}` : ""}</div>}
                    </div>
                  )}
                </td>
                <td>{describeValue(m, p.value)}{m?.v || m?.b ? <span className="muted"> ({p.value})</span> : null}</td>
                <td>
                  {!m?.ro && <ValueEditor key={`${p.name}-${s.paramsRev}-${resetToken}`} meta={m} value={st ?? p.value} onChange={(v) => stage(p.name, v)} />}
                  {bad.length > 0 && <div className="error-text">{bad.join("; ")}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > LIMIT && <p className="muted">Showing {LIMIT} of {rows.length}. Narrow the search to see more.</p>}
      {rows.length === 0 && <p className="muted">Nothing matches.</p>}
    </div>
  );
}

