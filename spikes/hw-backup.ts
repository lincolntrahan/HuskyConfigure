/**
 * Read-only: connect over USB, identify the board, download every parameter and save a backup.
 * Writes nothing to the vehicle.
 *
 *   npx tsx spikes/hw-backup.ts COM9 [label]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { MavConnection, ParamManager } from "../packages/vehicle/src/index.ts";
import { nodeSerialTransport } from "../packages/vehicle/src/nodeSerialTransport.ts";

const path = process.argv[2] ?? "COM9";
const label = process.argv[3] ?? "before-tests";

const conn = new MavConnection(await nodeSerialTransport(path));
await conn.ready(10000);
const hb = conn.lastHeartbeat!.fields;
console.log(`heartbeat: sysid ${conn.target.sysid} type ${hb.type} autopilot ${hb.autopilot} mode ${hb.custom_mode} armed ${conn.armed}`);

const verWait = conn.waitFor("AUTOPILOT_VERSION", () => true, 3000);
await conn.send("COMMAND_LONG", { target_system: conn.target.sysid, target_component: conn.target.compid, command: 512, param1: 148 });
const v = (await verWait).fields;
const fw = v.flight_sw_version;
const fwStr = `${(fw >> 24) & 0xff}.${(fw >> 16) & 0xff}.${(fw >> 8) & 0xff}`;
const git = String.fromCharCode(...v.flight_custom_version.filter((c) => c));
const uid2 = v.uid2 ? v.uid2.map((b) => b.toString(16).padStart(2, "0")).join("") : "";
console.log(`firmware ${fwStr} (type ${fw & 0xff}) git ${git}; board_version 0x${v.board_version.toString(16)} (APJ id ${v.board_version >>> 16}); vendor ${v.vendor_id.toString(16)} product ${v.product_id.toString(16)}`);
console.log(`uid ${v.uid} uid2 ${uid2} capabilities 0x${v.capabilities.toString(16)}`);

const texts: string[] = [];
conn.on("STATUSTEXT", (m) => texts.push(m.fields.text));

const pm = new ParamManager(conn);
const t0 = performance.now();
await pm.download({ onProgress: (p) => process.stdout.write(`\r  ${p.received}/${p.total} round ${p.round}   `) });
const secs = (performance.now() - t0) / 1000;
console.log(`\ndownloaded ${pm.params.size} params in ${secs.toFixed(1)} s; parser ${JSON.stringify(conn.parser.stats)}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync("backups", { recursive: true });
const base = `backups/${stamp}-${label}`;
const sorted = [...pm.params.values()].sort((a, b) => a.name.localeCompare(b.name));
// Mission Planner-compatible .param (NAME,VALUE). JS prints the exact float32 value, so a restore is bit-exact.
writeFileSync(`${base}.param`, sorted.map((p) => `${p.name},${p.value}`).join("\n") + "\n");
writeFileSync(`${base}.json`, JSON.stringify({
  savedAt: new Date().toISOString(), port: path,
  firmware: fwStr, git, boardVersion: v.board_version, uid: String(v.uid), uid2,
  params: sorted,
}, null, 1));
console.log(`saved ${base}.param and ${base}.json`);
await new Promise((r) => setTimeout(r, 1500));
if (texts.length) console.log("statustext:", texts.join(" | "));
await conn.close();
