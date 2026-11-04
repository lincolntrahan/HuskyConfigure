import { useState } from "react";
import type { ParamMeta } from "@husky/metadata";

/** Edits one parameter value: dropdown for enums, checkboxes for bitmasks, number otherwise. */
export function ValueEditor({ meta, value, onChange }: { meta?: ParamMeta; value: number; onChange: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(String(value));

  if (meta?.b) {
    const bits = Object.entries(meta.b).sort((a, b) => Number(a[0]) - Number(b[0]));
    const has = (bit: number) => Math.floor(Math.max(value, 0) / 2 ** bit) % 2 === 1;
    return (
      <div className="bitmask">
        <button className="small" onClick={() => setOpen(!open)}>{open ? "Done" : `Edit bits (${value})`}</button>
        {open && (
          <div className="bits">
            {bits.map(([bit, label]) => (
              <label key={bit}>
                <input type="checkbox" checked={has(Number(bit))}
                  onChange={(e) => onChange(Math.max(value, 0) + (e.target.checked ? 1 : -1) * 2 ** Number(bit))} />
                {label} <span className="muted">bit {bit}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (meta?.v && Object.keys(meta.v).length) {
    const known = meta.v[String(value)] !== undefined;
    return (
      <select value={known ? String(value) : "__other"} onChange={(e) => onChange(Number(e.target.value))}>
        {!known && <option value="__other">{value} (not a listed value)</option>}
        {Object.entries(meta.v).sort((a, b) => Number(a[0]) - Number(b[0])).map(([v, label]) => (
          <option key={v} value={v}>{v}: {label}</option>
        ))}
      </select>
    );
  }

  return (
    <input className="num" value={text} inputMode="decimal"
      step={meta?.i} onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
      }} />
  );
}
