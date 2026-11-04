import { useState } from "react";
import { describeValue, validateValue, type MetadataMatch } from "@husky/metadata";
import type { WriteChange, WriteReport } from "@husky/vehicle";
import { session, useSession } from "../state.ts";

export interface ReviewItem extends WriteChange { from?: number }

/**
 * The only way anything gets written: a plain-English list of every change, then a verified
 * write with a per-parameter result. Used by the parameter editor and by backup restore.
 */
export function Review({ items, meta, title, onDone, onCancel }: {
  items: ReviewItem[]; meta: MetadataMatch | null; title: string;
  onDone: (r: WriteReport) => void; onCancel: () => void;
}) {
  const s = useSession();
  const [report, setReport] = useState<WriteReport>();
  const [writing, setWriting] = useState(false);
  const m = (n: string) => meta?.set.params[n];
  const problems = items.flatMap((c) => validateValue(m(c.name), c.value).map((p) => `${c.name}: ${p}`));
  const reboot = items.filter((c) => m(c.name)?.rb).map((c) => c.name);
  const blocked = !session.canWrite;

  async function go() {
    setWriting(true);
    const r = await session.write(items, title);
    setWriting(false);
    setReport(r);
  }

  if (report) {
    const failed = report.results.filter((r) => !r.ok);
    return (
      <div className="review">
        <h2>{report.ok ? `All ${report.results.length} changes written and verified` : "Some changes did not stick"}</h2>
        {report.aborted && <p className="error-box">{report.aborted}</p>}
        {failed.length > 0 && (
          <table className="grid">
            <thead><tr><th>Parameter</th><th>Asked for</th><th>Board has</th></tr></thead>
            <tbody>{failed.map((f) => (
              <tr key={f.name} className="bad-row"><td>{f.name}</td><td>{f.requested}</td><td>{f.echoed ?? "no answer"}</td></tr>
            ))}</tbody>
          </table>
        )}
        {report.results.length - failed.length > 0 && <p className="muted">{report.results.length - failed.length} verified by reading them back from the board.</p>}
        {s.rebootNeeded.length > 0 && <p className="warn-box">Some changes only take effect after a reboot. Use the button in the top bar.</p>}
        <button className="primary" onClick={() => onDone(report)}>Close</button>
      </div>
    );
  }

  return (
    <div className="review">
      <h2>{title}: review {items.length} change{items.length === 1 ? "" : "s"}</h2>
      <table className="grid">
        <thead><tr><th>Setting</th><th>Now</th><th></th><th>New</th></tr></thead>
        <tbody>
          {items.map((c) => {
            const pm = m(c.name);
            const bad = validateValue(pm, c.value);
            return (
              <tr key={c.name} className={bad.length ? "bad-row" : ""}>
                <td><strong>{pm?.n ?? c.name}</strong><div className="muted mono">{c.name}</div></td>
                <td>{c.from === undefined ? <span className="muted">new</span> : describeValue(pm, c.from)}</td>
                <td>→</td>
                <td>{describeValue(pm, c.value)}{bad.length > 0 && <div className="error-text">{bad.join("; ")}</div>}{pm?.rb && <div className="warn-text">needs reboot</div>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {problems.length > 0 && <p className="error-box">Fix the values marked in red before writing.</p>}
      {reboot.length > 0 && <p className="warn-box">{reboot.length} of these only take effect after a reboot.</p>}
      {blocked && <p className="error-box">Writing is locked: {s.armed ? "the vehicle is ARMED" : !s.backup ? "no backup yet" : "not connected"}.</p>}
      <div className="row">
        <button className="primary" disabled={blocked || problems.length > 0 || writing || items.length === 0} onClick={() => void go()}>
          {writing ? "Writing…" : `Write ${items.length} change${items.length === 1 ? "" : "s"} to the board`}
        </button>
        <button disabled={writing} onClick={onCancel}>Back</button>
      </div>
    </div>
  );
}
