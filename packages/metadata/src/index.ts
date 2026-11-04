/**
 * Parameter metadata generated from ArduPilot's own source at each release tag
 * (tools/gen-metadata). Bundled, so it works offline.
 */
export interface ParamMeta {
  /** display name */
  n?: string;
  /** description */
  d?: string;
  /** units */
  u?: string;
  /** [low, high] */
  r?: [number, number];
  /** enum values: value → label */
  v?: Record<string, string>;
  /** bitmask: bit → label */
  b?: Record<string, string>;
  /** increment */
  i?: number;
  /** reboot required after change */
  rb?: 1;
  /** read-only */
  ro?: 1;
  /** "Advanced" user level */
  adv?: 1;
  /** calibration result (sensor offsets etc): belongs to one physical board */
  cal?: 1;
  /** library group, e.g. "SERVO", "ARSPD" */
  g: string;
}

export interface MetadataSet {
  vehicle: "Plane";
  version: string;
  source: string;
  params: Record<string, ParamMeta>;
}

const LOADERS: Record<string, () => Promise<{ default: MetadataSet }>> = {
  "4.7.2": () => import("../data/plane-4.7.2.json") as unknown as Promise<{ default: MetadataSet }>,
};

export const AVAILABLE_VERSIONS = Object.keys(LOADERS);

export interface MetadataMatch {
  set: MetadataSet;
  /** exact: same release; minor: same major.minor; other: best guess */
  quality: "exact" | "minor" | "other";
}

const cmp = (a: string, b: string) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

export async function loadMetadata(firmware: string): Promise<MetadataMatch> {
  if (LOADERS[firmware]) return { set: (await LOADERS[firmware]!()).default, quality: "exact" };
  const mm = firmware.split(".").slice(0, 2).join(".");
  const sameMinor = AVAILABLE_VERSIONS.filter((v) => v.startsWith(mm + ".")).sort(cmp);
  const pick = sameMinor.at(-1) ?? AVAILABLE_VERSIONS.sort(cmp).at(-1)!;
  return { set: (await LOADERS[pick]!()).default, quality: sameMinor.length ? "minor" : "other" };
}

/** Human-readable value: enum label, bitmask bit list, or number with units. */
export function describeValue(meta: ParamMeta | undefined, value: number): string {
  if (!meta) return String(value);
  if (meta.v && meta.v[String(value)] !== undefined) return `${meta.v[String(value)]}`;
  if (meta.b) {
    if (value === 0) return "none";
    if (value < 0) return String(value);
    const bits = Object.entries(meta.b).filter(([bit]) => (Math.floor(value / 2 ** Number(bit)) % 2) === 1).map(([, l]) => l);
    return bits.length ? bits.join(", ") : String(value);
  }
  return meta.u ? `${value} ${meta.u}` : String(value);
}

/** Problems with a proposed value, per the metadata. Empty = fine. */
export function validateValue(meta: ParamMeta | undefined, value: number): string[] {
  const out: string[] = [];
  if (!Number.isFinite(value)) return ["not a number"];
  if (!meta) return out;
  if (meta.ro) out.push("read-only parameter");
  if (meta.r && (value < meta.r[0] || value > meta.r[1])) out.push(`outside range ${meta.r[0]} … ${meta.r[1]}`);
  if (meta.v && !meta.b && meta.v[String(value)] === undefined) out.push("not one of the listed values");
  return out;
}
