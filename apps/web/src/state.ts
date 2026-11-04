import { useEffect, useState, useSyncExternalStore } from "react";
import { Session, indexedDbBackupStore, memoryBackupStore } from "@husky/vehicle";
import { loadMetadata, type MetadataMatch } from "@husky/metadata";

let metaCache: MetadataMatch | undefined;

export const session = new Session(
  typeof indexedDB !== "undefined" ? indexedDbBackupStore() : memoryBackupStore(),
  // AHRS_ORIENTATION only takes effect at boot, but its metadata doesn't say so
  { rebootRequired: (name) => name === "AHRS_ORIENTATION" || metaCache?.set.params[name]?.rb === 1 },
);

// Handy in the browser console while developing.
(globalThis as unknown as { husky?: unknown }).husky = { session };

export function useSession() {
  return useSyncExternalStore(session.subscribe, () => session.snapshot);
}

/** Metadata for the connected firmware (null while loading / disconnected). */
export function useMetadata(): MetadataMatch | null {
  const s = useSession();
  const fw = s.info?.firmware;
  const [m, setM] = useState<MetadataMatch | null>(metaCache ?? null);
  useEffect(() => {
    if (!fw) return;
    let live = true;
    void loadMetadata(fw).then((r) => { metaCache = r; if (live) setM(r); });
    return () => { live = false; };
  }, [fw]);
  return fw ? m : null;
}

export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const PLANE_MODES: Record<number, string> = {
  0: "MANUAL", 1: "CIRCLE", 2: "STABILIZE", 3: "TRAINING", 4: "ACRO", 5: "FBWA", 6: "FBWB", 7: "CRUISE",
  8: "AUTOTUNE", 10: "AUTO", 11: "RTL", 12: "LOITER", 13: "TAKEOFF", 14: "AVOID_ADSB", 15: "GUIDED",
  17: "QSTABILIZE", 18: "QHOVER", 19: "QLOITER", 20: "QLAND", 21: "QRTL", 22: "QAUTOTUNE", 23: "QACRO",
  24: "THERMAL", 25: "LOITER_ALT_QLAND", 26: "AUTOLAND",
};
