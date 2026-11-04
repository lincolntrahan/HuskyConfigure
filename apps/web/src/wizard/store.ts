/**
 * Wizard state: the aircraft profile being edited (saved in this browser per board, and
 * exportable as JSON for the team repo) plus derived compile results.
 */
import { useMemo, useSyncExternalStore } from "react";
import {
  compile, evaluate, DEFAULT_POLICY, checkStatus, recordCheck,
  type BoardFacts, type Compiled, type Finding, type Profile, type RuleContext,
} from "@husky/profile";
import { session, useSession } from "../state.ts";

let profile: Profile | null = null;
let loadedFor: string | undefined;
const subs = new Set<() => void>();
const key = (uid: string) => `husky.profile.${uid}`;

function notify() { subs.forEach((cb) => cb()); }

export function setProfile(p: Profile | null) {
  profile = p;
  if (p && loadedFor) {
    try { localStorage.setItem(key(loadedFor), JSON.stringify(p)); } catch { /* storage full or blocked */ }
  }
  notify();
}

export function updateProfile(fn: (p: Profile) => Profile) {
  if (profile) setProfile(fn(profile));
}

function ensureLoaded(uid: string | undefined) {
  if (!uid || uid === loadedFor) return;
  loadedFor = uid;
  try {
    const raw = localStorage.getItem(key(uid));
    profile = raw ? (JSON.parse(raw) as Profile) : null;
  } catch { profile = null; }
}

export function useProfile(): Profile | null {
  const s = useSession();
  ensureLoaded(s.info?.uid);
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => profile);
}

export function boardMap(): Map<string, number> {
  return new Map([...session.params.values()].map((p) => [p.name, p.value]));
}

export function boardFacts(): RuleContext {
  const params = boardMap();
  const hw = session.hwdef;
  const outputs = hw?.pwm.length ? Math.max(...hw.pwm.map((p) => p.n)) : 16;
  const groups = hw?.pwm.length
    ? Object.values(hw.pwm.reduce<Record<string, number[]>>((g, p) => { (g[p.timer] ??= []).push(p.n); return g; }, {}))
    : undefined;
  const facts: BoardFacts = { params, hasScripting: params.has("SCR_ENABLE"), outputs };
  return { ...facts, timerGroups: groups, target: session.snapshot.info?.target };
}

export interface Derived { compiled: Compiled; findings: Finding[]; facts: RuleContext; board: Map<string, number> }

export function useDerived(p: Profile | null): Derived | null {
  const s = useSession();
  return useMemo(() => {
    if (!p) return null;
    const facts = boardFacts();
    const compiled = compile(p, facts, DEFAULT_POLICY.allowedModes);
    return { compiled, findings: evaluate(p, compiled, facts, DEFAULT_POLICY), facts, board: facts.params as Map<string, number> };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, s.paramsRev]);
}

export function check(id: string, p: Profile) { return checkStatus(id, p, boardMap()); }
export function passCheck(id: string) { updateProfile((p) => recordCheck(id, p, boardMap())); }

/** Props-off confirmation: asked again on every new connection. */
let propsOffFor: string | undefined;
const linkKey = () => `${session.snapshot.info?.uid ?? ""}|${session.snapshot.link ?? ""}`;
export function propsConfirmed(): boolean { return propsOffFor === linkKey(); }
export function confirmProps() { propsOffFor = linkKey(); notify(); }

export function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
