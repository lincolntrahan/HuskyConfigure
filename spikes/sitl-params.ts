/**
 * Phase 0 spike: connect to SITL, identify the vehicle, download all params, do a verified
 * write + restore, and report which parameter names this firmware uses for things the design
 * depends on.
 *
 *   npx tsx spikes/sitl-params.ts [host] [port]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { MavConnection, ParamManager } from "../packages/vehicle/src/index.ts";
import { tcpTransport } from "../packages/vehicle/src/tcpTransport.ts";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 5760);

const conn = new MavConnection(await tcpTransport(host, port));
await conn.ready(10000);
const hb = conn.lastHeartbeat!.fields;
console.log(`vehicle sysid ${conn.target.sysid} type ${hb.type} autopilot ${hb.autopilot} armed ${conn.armed}`);

// MAV_CMD_REQUEST_MESSAGE (512) for AUTOPILOT_VERSION (148)
const verWait = conn.waitFor("AUTOPILOT_VERSION", () => true, 3000);
await conn.send("COMMAND_LONG", {
  target_system: conn.target.sysid, target_component: conn.target.compid, command: 512, param1: 148,
});
const ver = (await verWait).fields;
const fw = ver.flight_sw_version;
console.log(`firmware ${(fw >> 24) & 0xff}.${(fw >> 16) & 0xff}.${(fw >> 8) & 0xff} type ${fw & 0xff}, board_version 0x${ver.board_version.toString(16)}, uid ${ver.uid}`);
console.log(`  git ${String.fromCharCode(...ver.flight_custom_version.filter((c) => c))}`);

const pm = new ParamManager(conn);
const t0 = performance.now();
let last = 0;
await pm.download({
  onProgress: (p) => {
    if (p.received - last >= 250 || p.round) { last = p.received; process.stdout.write(`\r  ${p.received}/${p.total} (round ${p.round})   `); }
  },
});
console.log(`\ndownloaded ${pm.params.size} params in ${((performance.now() - t0) / 1000).toFixed(1)} s; parser ${JSON.stringify(conn.parser.stats)}`);

// Verified write + restore of a harmless param.
const name = "SERVO3_REVERSED";
const before = pm.params.get(name)!.value;
const r1 = await pm.set(name, before ? 0 : 1);
const r2 = await pm.set(name, before);
const reread = await pm.read(name);
console.log(`set ${name}: ${JSON.stringify(r1)}\nrestore: ${JSON.stringify(r2)}\nre-read: ${reread.value}`);

// A value the vehicle should clamp or refuse, to see what the echo looks like.
const r3 = await pm.set("SERVO3_TRIM", 99999);
console.log(`out-of-range SERVO3_TRIM=99999 -> ${JSON.stringify(r3)}`);
if (r3.echoed !== undefined && r3.echoed !== pm.params.get("SERVO3_TRIM")?.value) console.log("  (vehicle changed it)");
await pm.set("SERVO3_TRIM", 1500);

// Names the design depends on.
const probe = [
  "ARMING_CHECK", "ARMING_SKIPCHK", "ARMING_RUDDER", "ARMING_REQUIRE", "ARMING_OPTIONS",
  "SR0_EXTRA1", "MAV1_EXTRA1", "MAV1_OPTIONS", "SERIAL1_OPTIONS",
  "FLTMODE_GCSBLOCK", "FLTMODE_CH", "INITIAL_MODE",
  "THR_FAILSAFE", "FS_SHORT_ACTN", "FS_LONG_ACTN", "FS_SHORT_TIMEOUT", "FS_LONG_TIMEOUT", "RC_FS_TIMEOUT",
  "SERVO_RC_FS_MSK", "AFS_ENABLE", "SCR_ENABLE", "SCR_LD_CHECKSUM", "SCR_RUN_CHECKSUM", "SCR_HEAP_SIZE",
  "SERVO_BLH_MASK", "SERVO_BLH_OTYPE", "SERVO_BLH_BDMASK", "SERVO_DSHOT_ESC",
  "DSPOILER_OPTS", "MIXING_GAIN", "SIM_RC_FAIL",
];
for (const p of probe) console.log(`  ${p.padEnd(18)} ${pm.params.has(p) ? pm.params.get(p)!.value : "— not present"}`);

mkdirSync("spikes/out", { recursive: true });
writeFileSync("spikes/out/sitl-4.7.2.param",
  [...pm.params.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `${p.name},${p.value}`).join("\n") + "\n");
console.log("wrote spikes/out/sitl-4.7.2.param");
await conn.close();
