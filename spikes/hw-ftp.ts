/**
 * Hardware: MAVLink FTP.
 *   1. list /, /APM, /APM/scripts (saved next to the param backup)
 *   2. fetch @PARAM/param.pck, decode, compare with the param backup
 *   3. if the SD card accepts writes: write a test file, read it back, delete it
 *
 *   npx tsx spikes/hw-ftp.ts COM9 backups/<stamp>-before-tests.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { MavConnection, MavFtp, FtpError, parseParamPck } from "../packages/vehicle/src/index.ts";
import { nodeSerialTransport } from "../packages/vehicle/src/nodeSerialTransport.ts";

const backupPath = process.argv[3]!;
const backup = JSON.parse(readFileSync(backupPath, "utf8")) as { params: { name: string; value: number }[] };

const conn = new MavConnection(await nodeSerialTransport(process.argv[2] ?? "COM9"));
await conn.ready(10000);
const texts: string[] = [];
conn.on("STATUSTEXT", (m) => texts.push(m.fields.text));
const ftp = new MavFtp(conn);
await ftp.resetSessions();

// 1. listings
const listing: Record<string, unknown> = {};
for (const dir of ["/", "/APM", "/APM/scripts", "/APM/LOGS", "@ROMFS", "@ROMFS/scripts"]) {
  try {
    const l = await ftp.list(dir);
    listing[dir] = l;
    console.log(`${dir}: ${l.map((e) => e.type === "dir" ? e.name + "/" : `${e.name} (${e.size})`).join(", ") || "(empty)"}`);
  } catch (e) {
    listing[dir] = { error: (e as Error).message };
    console.log(`${dir}: ${(e as Error).message}`);
  }
}
writeFileSync(backupPath.replace(/\.json$/, ".sdcard.json"), JSON.stringify(listing, null, 1));

// 2. param.pck
const t0 = performance.now();
const pck = await ftp.read("@PARAM/param.pck");
const secs = (performance.now() - t0) / 1000;
const decoded = parseParamPck(pck);
const ref = new Map(backup.params.map((p) => [p.name, p.value]));
const mismatch = decoded.filter((p) => !ref.has(p.name) || Math.fround(ref.get(p.name)!) !== Math.fround(p.value));
const missing = [...ref.keys()].filter((n) => !decoded.some((p) => p.name === n));
console.log(`param.pck: ${pck.length} bytes, ${decoded.length} params in ${secs.toFixed(2)} s; ` +
  `mismatches vs backup ${mismatch.length}, missing ${missing.length}`);
if (mismatch.length) console.log("  mismatches:", mismatch.slice(0, 10));
if (missing.length) console.log("  missing:", missing.slice(0, 10));

// 3. write test (only touches a file we create, then removes it)
const testPath = "/APM/hsk_ftp_test.txt";
const content = new TextEncoder().encode("HuskyConfigure MAVFTP test\n".repeat(20)); // 540 bytes, 3 chunks
try {
  const exists = (await ftp.list("/APM").catch(() => [])).some((e) => e.name === "hsk_ftp_test.txt");
  if (exists) throw new Error("test file already exists; not touching it");
  await ftp.write(testPath, content);
  const back = await ftp.read(testPath);
  const same = back.length === content.length && back.every((b, i) => b === content[i]);
  console.log(`write ${content.length} bytes → read back ${back.length}, identical=${same}`);
  await ftp.remove(testPath);
  const gone = !(await ftp.list("/APM")).some((e) => e.name === "hsk_ftp_test.txt");
  console.log(`removed test file: ${gone}`);
} catch (e) {
  console.log(`write test: ${e instanceof FtpError ? e.message : (e as Error).message}`);
}

await new Promise((r) => setTimeout(r, 500));
if (texts.length) console.log("statustext:", texts.join(" | "));
await conn.close();
