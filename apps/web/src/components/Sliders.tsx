import { useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";

/**
 * A range input whose filled part goes exactly from completely empty (at min) to completely
 * full (at max): the fill is offset by half the thumb so nothing peeks out at either end.
 */
export function Slider({ value, min, max, step = 1, onChange, className, title }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; className?: string; title?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input type="range" className={`slider ${className ?? ""}`} min={min} max={max} step={step} value={value} title={title}
      style={{ "--p": `${Math.max(0, Math.min(100, pct))}` } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))} />
  );
}

/** PWM ↔ percent: ±100 % = 1000–2000 µs around 1500. */
export const pctToUs = (pct: number) => Math.round(1500 + pct * 5);
export const usToPct = (us: number) => Math.round((us - 1500) / 5);
export const US_LIMITS = { min: 800, max: 2200 };
const SCALE = { lo: 875, hi: 2125 }; // the slider shows ±125 %; typed values may go to 800–2200

type Field = "min" | "trim" | "max";

/**
 * Low end, center and high end of a servo on one track, plus number fields in % and µs.
 * Keeps min < center < max with at least 10 µs between them.
 */
export function EndpointSlider({ min, trim, max, live, reversed, onChange }: {
  min: number; trim: number; max: number; live?: number; reversed?: boolean;
  onChange: (field: Field, us: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Field | null>(null);
  const x = (us: number) => `${((Math.max(SCALE.lo, Math.min(SCALE.hi, us)) - SCALE.lo) / (SCALE.hi - SCALE.lo)) * 100}%`;
  const vals = { min, trim, max };

  function clampFor(f: Field, us: number) {
    us = Math.round(Math.max(US_LIMITS.min, Math.min(US_LIMITS.max, us)));
    if (f === "min") return Math.min(us, trim - 10);
    if (f === "max") return Math.max(us, trim + 10);
    return Math.max(min + 10, Math.min(max - 10, us));
  }
  function fromPointer(e: RPointerEvent) {
    const r = ref.current!.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return SCALE.lo + t * (SCALE.hi - SCALE.lo);
  }
  const handle = (f: Field) => (
    <span className={`ep-handle ${f}`} style={{ left: x(vals[f]) }} role="slider" aria-label={f}
      aria-valuenow={vals[f]} aria-valuemin={US_LIMITS.min} aria-valuemax={US_LIMITS.max} tabIndex={0}
      onKeyDown={(e) => {
        const d = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
        if (d) { e.preventDefault(); onChange(f, clampFor(f, vals[f] + d)); }
      }}
      onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture(e.pointerId); setDrag(f); }}
      onPointerMove={(e) => { if (drag === f) onChange(f, clampFor(f, Math.round(fromPointer(e) / 5) * 5)); }}
      onPointerUp={() => setDrag(null)} />
  );
  const row = (f: Field, label: string) => (
    <div className="ep-row">
      <span>{label}</span>
      <NumberField value={usToPct(vals[f])} suffix="%" onCommit={(v) => onChange(f, clampFor(f, pctToUs(v)))} />
      <NumberField value={vals[f]} suffix="µs" onCommit={(v) => onChange(f, clampFor(f, v))} />
    </div>
  );
  return (
    <div className="ep">
      <div className="ep-track" ref={ref}>
        <span className="ep-fill" style={{ left: x(min), width: `calc(${x(max)} - ${x(min)})` }} />
        {[-100, 0, 100].map((p) => <span key={p} className="ep-tick" style={{ left: x(pctToUs(p)) }}><span>{p}%</span></span>)}
        {live ? <span className="ep-live" style={{ left: x(live) }} title={`output now ${live} µs`} /> : null}
        {handle("min")}{handle("trim")}{handle("max")}
      </div>
      <div className="ep-fields">
        {row("min", "Low end")}
        {row("trim", "Center")}
        {row("max", "High end")}
        {reversed && <span className="muted">Reversed: the surface's "up" travel uses the low end.</span>}
      </div>
    </div>
  );
}

/** A number box that only commits on Enter or leaving the field (so typing "1" of "1500" doesn't apply 1). */
export function NumberField({ value, onCommit, suffix, width = "5.5em" }: { value: number; onCommit: (v: number) => void; suffix?: string; width?: string }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const v = Number(text);
    if (text.trim() !== "" && Number.isFinite(v)) onCommit(v);
    setText(null);
  };
  return (
    <span className="numfield">
      <input className="num" style={{ width }} inputMode="decimal" value={text ?? String(value)}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setText(null); }} />
      {suffix && <span className="muted">{suffix}</span>}
    </span>
  );
}
