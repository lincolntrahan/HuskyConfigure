/**
 * MAVLink FTP client (https://mavlink.io/en/services/ftp.html), enough for:
 * listing directories, reading files (incl. ArduPilot's virtual @PARAM/param.pck),
 * writing files (scripts), removing files.
 *
 * One request in flight at a time. Each request is retried on timeout with the same
 * sequence number; responses are matched on seq = request seq + 1.
 */
import type { MavConnection } from "./connection.ts";

export const OP = {
  None: 0, TerminateSession: 1, ResetSessions: 2, ListDirectory: 3, OpenFileRO: 4, ReadFile: 5,
  CreateFile: 6, WriteFile: 7, RemoveFile: 8, CreateDirectory: 9, RemoveDirectory: 10,
  OpenFileWO: 11, TruncateFile: 12, Rename: 13, CalcFileCRC32: 14, BurstReadFile: 15,
  ACK: 128, NAK: 129,
} as const;

export const NAK = [
  "None", "Fail", "FailErrno", "InvalidDataSize", "InvalidSession", "NoSessionsAvailable",
  "EOF", "UnknownCommand", "FileExists", "FileProtected", "FileNotFound",
] as const;

const DATA_MAX = 239;

export class FtpError extends Error {
  constructor(readonly op: number, readonly code: number, readonly errno?: number) {
    super(`FTP op ${op} NAK ${NAK[code] ?? code}${errno !== undefined ? ` (errno ${errno})` : ""}`);
  }
  get notFound() { return this.code === 10 || (this.code === 2 && this.errno === 2); }
  get eof() { return this.code === 6; }
}

interface Reply { opcode: number; reqOpcode: number; session: number; size: number; offset: number; data: Uint8Array }

export interface DirEntry { name: string; type: "file" | "dir"; size?: number }

export class MavFtp {
  private seq = 0;

  constructor(private readonly conn: MavConnection, private readonly timeoutMs = 1000, private readonly retries = 5) {}

  private async request(opcode: number, f: { session?: number; offset?: number; size?: number; data?: Uint8Array } = {}): Promise<Reply> {
    const seq = this.seq = (this.seq + 1) & 0xffff;
    const payload = new Uint8Array(251);
    const dv = new DataView(payload.buffer);
    const data = f.data ?? new Uint8Array(0);
    if (data.length > DATA_MAX) throw new Error("FTP data too long");
    dv.setUint16(0, seq, true);
    payload[2] = f.session ?? 0;
    payload[3] = opcode;
    payload[4] = f.size ?? data.length;
    dv.setUint32(8, f.offset ?? 0, true);
    payload.set(data, 12);

    for (let attempt = 0; attempt < this.retries; attempt++) {
      const wait = this.conn.waitFor("FILE_TRANSFER_PROTOCOL", (m) => {
        const p = m.fields.payload;
        return ((p[0]! | (p[1]! << 8)) === ((seq + 1) & 0xffff)) && p[5] === opcode;
      }, this.timeoutMs);
      await this.conn.send("FILE_TRANSFER_PROTOCOL", {
        target_network: 0, target_system: this.conn.target.sysid, target_component: this.conn.target.compid,
        payload: [...payload],
      });
      let m;
      try { m = await wait; } catch { continue; }
      const p = Uint8Array.from(m.fields.payload);
      const r: Reply = {
        session: p[2]!, opcode: p[3]!, size: p[4]!, reqOpcode: p[5]!,
        offset: new DataView(p.buffer).getUint32(8, true), data: p.slice(12, 12 + p[4]!),
      };
      if (r.opcode === OP.NAK) throw new FtpError(opcode, r.data[0] ?? 1, r.data[0] === 2 ? r.data[1] : undefined);
      return r;
    }
    throw new Error(`FTP op ${opcode}: no reply after ${this.retries} tries`);
  }

  private static path(p: string) { return new TextEncoder().encode(p); }

  resetSessions() { return this.request(OP.ResetSessions); }

  async list(dir: string): Promise<DirEntry[]> {
    const out: DirEntry[] = [];
    let index = 0; // entry index for the next request; "S" (skipped) entries count too
    for (;;) {
      let r: Reply;
      try { r = await this.request(OP.ListDirectory, { offset: index, data: MavFtp.path(dir) }); }
      catch (e) { if (e instanceof FtpError && e.eof) break; throw e; }
      const parts = new TextDecoder().decode(r.data).split("\0").filter(Boolean);
      if (!parts.length) break;
      for (const s of parts) {
        index++;
        if (s[0] === "F") {
          const [name, size] = s.slice(1).split("\t");
          out.push({ name: name!, type: "file", size: Number(size) });
        } else if (s[0] === "D") {
          out.push({ name: s.slice(1), type: "dir" });
        }
      }
    }
    return out;
  }

  async read(path: string, onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
    const open = await this.request(OP.OpenFileRO, { data: MavFtp.path(path) });
    const session = open.session;
    const total = new DataView(open.data.buffer, open.data.byteOffset).getUint32(0, true);
    const chunks: Uint8Array[] = [];
    let offset = 0;
    try {
      while (offset < total) {
        let r: Reply;
        try { r = await this.request(OP.ReadFile, { session, offset, size: DATA_MAX }); }
        catch (e) { if (e instanceof FtpError && e.eof) break; throw e; }
        if (!r.data.length) break;
        chunks.push(r.data);
        offset += r.data.length;
        onProgress?.(offset, total);
      }
    } finally {
      await this.request(OP.TerminateSession, { session }).catch(() => {});
    }
    const out = new Uint8Array(offset);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const c = await this.request(OP.CreateFile, { data: MavFtp.path(path) });
    const session = c.session;
    try {
      for (let off = 0; off < bytes.length; off += DATA_MAX) {
        await this.request(OP.WriteFile, { session, offset: off, data: bytes.subarray(off, off + DATA_MAX) });
      }
    } finally {
      await this.request(OP.TerminateSession, { session }).catch(() => {});
    }
  }

  async remove(path: string): Promise<void> {
    await this.request(OP.RemoveFile, { data: MavFtp.path(path) });
  }

  async mkdir(path: string): Promise<void> {
    try { await this.request(OP.CreateDirectory, { data: MavFtp.path(path) }); }
    catch (e) { if (!(e instanceof FtpError && e.code === 8)) throw e; } // exists is fine
  }
}

/**
 * Decode ArduPilot's packed parameter file (@PARAM/param.pck).
 * Header: magic u16 (0x671b, or 0x671c when defaults are included), num_params u16, total u16.
 * Entry: [type:4 | flags:4] [common_len:4 | (name_len-1):4] name-suffix value [default].
 * Names are prefix-compressed against the previous entry. Zero bytes between entries are padding.
 */
export function parseParamPck(buf: Uint8Array): { name: string; value: number; type: number }[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint16(0, true);
  if (magic !== 0x671b && magic !== 0x671c) throw new Error(`bad param.pck magic 0x${magic.toString(16)}`);
  const withDefaults = magic === 0x671c;
  const count = dv.getUint16(2, true);
  const SIZE = [0, 1, 2, 4, 4];
  const out: { name: string; value: number; type: number }[] = [];
  let last = "";
  let i = 6;
  while (out.length < count && i < buf.length) {
    const tf = buf[i]!;
    if (tf === 0) { i++; continue; } // padding
    const type = tf & 0x0f;
    const flags = tf >> 4;
    const lens = buf[i + 1]!;
    const common = lens & 0x0f;
    const nameLen = (lens >> 4) + 1;
    i += 2;
    const suffix = new TextDecoder().decode(buf.subarray(i, i + nameLen));
    i += nameLen;
    const name = last.slice(0, common) + suffix;
    last = name;
    const read = (t: number, at: number) =>
      t === 1 ? dv.getInt8(at) : t === 2 ? dv.getInt16(at, true) : t === 3 ? dv.getInt32(at, true) : dv.getFloat32(at, true);
    if (!SIZE[type]) throw new Error(`bad param type ${type} at ${i}`);
    const value = read(type, i);
    i += SIZE[type]!;
    if (withDefaults && (flags & 1)) i += SIZE[type]!; // a default follows
    // MAV_PARAM_TYPE: int8=2, int16=4, int32=6, float=9
    out.push({ name, value, type: [0, 2, 4, 6, 9][type]! });
  }
  return out;
}
