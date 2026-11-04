/**
 * Convert ArduPilot's apm.pdef.json (from Tools/autotest/param_metadata/param_parse.py, run at a
 * release tag) into the compact bundle in packages/metadata/data.
 *
 *   npx tsx tools/gen-metadata/convert.ts <apm.pdef.json> <version> [source-note]
 *
 * See tools/gen-metadata/README.md for the full regeneration recipe.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Raw = Record<string, Record<string, {
  DisplayName?: string; Description?: string; Units?: string; Range?: { low: string; high: string };
  Values?: Record<string, string>; Bitmask?: Record<string, string>; Increment?: string;
  RebootRequired?: string; ReadOnly?: string; User?: string; Calibration?: string;
} | number>>;

const [inFile, version, note] = process.argv.slice(2);
if (!inFile || !version) { console.error("usage: convert.ts <apm.pdef.json> <version> [note]"); process.exit(2); }
const raw = JSON.parse(readFileSync(inFile, "utf8")) as Raw;

const params: Record<string, unknown> = {};
for (const [group, ps] of Object.entries(raw)) {
  if (group === "json") continue;
  for (const [name, p] of Object.entries(ps)) {
    if (typeof p !== "object") continue;
    const m: Record<string, unknown> = { g: group.replace(/_$/, "") || "Plane" };
    if (p.DisplayName) m.n = p.DisplayName;
    if (p.Description) m.d = p.Description.trim();
    if (p.Units) m.u = p.Units;
    if (p.Range) m.r = [Number(p.Range.low), Number(p.Range.high)];
    if (p.Values && Object.keys(p.Values).length) m.v = p.Values;
    if (p.Bitmask && Object.keys(p.Bitmask).length) m.b = p.Bitmask;
    if (p.Increment && Number.isFinite(Number(p.Increment))) m.i = Number(p.Increment);
    if (p.RebootRequired === "True") m.rb = 1;
    if (p.ReadOnly === "True") m.ro = 1;
    if (p.User === "Advanced") m.adv = 1;
    if (p.Calibration === "1") m.cal = 1;
    params[name] = m;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, `../../packages/metadata/data/plane-${version}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ vehicle: "Plane", version, source: note ?? "param_parse.py", params }));
console.log(`wrote ${Object.keys(params).length} params -> ${out}`);
