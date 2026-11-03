/**
 * Hardware: verified writes on real flash, each restored to its original value.
 * Uses spare output 13 (nothing plugged in). Restores even if a step fails.
 *
 *   npx tsx spikes/hw-write.ts COM9
 */
import { MavConnection, ParamManager } from "../packages/vehicle/src/index.ts";
import { nodeSerialTransport } from "../packages/vehicle/src/nodeSerialTransport.ts";

const conn = new MavConnection(await nodeSerialTransport(process.argv[2] ?? "COM9"));
await conn.ready(10000);
if (conn.armed) throw new Error("vehicle armed; aborting");
const pm = new ParamManager(conn);

const names = ["SERVO13_REVERSED", "SERVO13_TRIM"];
const original = new Map<string, number>();
for (const n of names) original.set(n, (await pm.read(n).catch(() => undefined))?.value ?? NaN);
// read() needs the param known for set(); seed the cache with a read of each
console.log("original:", Object.fromEntries(original));
if ([...original.values()].some((v) => Number.isNaN(v))) throw new Error("could not read originals");

try {
  const t0 = performance.now();
  const a = await pm.set("SERVO13_REVERSED", original.get("SERVO13_REVERSED") ? 0 : 1);
  console.log(`toggle SERVO13_REVERSED: ${JSON.stringify(a)} in ${Math.round(performance.now() - t0)} ms`);
  const b = await pm.set("SERVO13_TRIM", 99999);
  console.log(`out-of-range SERVO13_TRIM=99999: ${JSON.stringify(b)}`);
  const c = await pm.set("SERVO13_TRIM", 1499.5);
  console.log(`fractional SERVO13_TRIM=1499.5 (int16 param): ${JSON.stringify(c)}`);
} finally {
  for (const [n, v] of original) {
    const r = await pm.set(n, v);
    const back = await pm.read(n);
    console.log(`restore ${n}=${v}: ok=${r.ok}, re-read ${back.value}`);
  }
  await conn.close();
}
