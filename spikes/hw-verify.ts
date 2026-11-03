/**
 * Hardware: save the board's own hwdef/defaults from ROMFS, then diff every parameter against
 * a backup. STAT_* counters (boot count, runtime, flight time) are expected to differ.
 *
 *   npx tsx spikes/hw-verify.ts COM9 backups/<stamp>-before-tests.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { MavConnection, MavFtp, parseParamPck } from "../packages/vehicle/src/index.ts";
import { nodeSerialTransport } from "../packages/vehicle/src/nodeSerialTransport.ts";

const backupPath = process.argv[3]!;
const backup = JSON.parse(readFileSync(backupPath, "utf8")) as { params: { name: string; value: number }[] };

const conn = new MavConnection(await nodeSerialTransport(process.argv[2] ?? "COM9"));
await conn.ready(10000);
const ftp = new MavFtp(conn);
await ftp.resetSessions();

for (const f of ["hwdef.dat", "defaults.parm"]) {
  const bytes = await ftp.read(`@ROMFS/${f}`);
  const out = backupPath.replace(/\.json$/, `.${f}`);
  writeFileSync(out, bytes);
  console.log(`saved ${out} (${bytes.length} bytes)`);
}

const now = parseParamPck(await ftp.read("@PARAM/param.pck"));
const ref = new Map(backup.params.map((p) => [p.name, p.value]));
const cur = new Map(now.map((p) => [p.name, p.value]));
const counters = /^STAT_/;
const changed = [...ref].filter(([n, v]) => cur.has(n) && Math.fround(cur.get(n)!) !== Math.fround(v));
const added = [...cur.keys()].filter((n) => !ref.has(n));
const removed = [...ref.keys()].filter((n) => !cur.has(n));
const real = changed.filter(([n]) => !counters.test(n));
console.log(`compared ${ref.size} backed-up params with ${cur.size} on the board`);
console.log(`  changed: ${real.length} (+ ${changed.length - real.length} STAT_ counters: ${changed.filter(([n]) => counters.test(n)).map(([n, v]) => `${n} ${v}→${cur.get(n)}`).join(", ")})`);
for (const [n, v] of real) console.log(`    ${n}: ${v} → ${cur.get(n)}`);
console.log(`  added: ${added.length ? added.join(", ") : 0}; removed: ${removed.length ? removed.join(", ") : 0}`);
console.log(real.length || added.length || removed.length ? "RESULT: DIFFERS from backup" : "RESULT: matches backup");
await conn.close();
