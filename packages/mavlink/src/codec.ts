import { x25Accumulate, x25AccumulateByte, X25_INIT } from "./crc.ts";
import type { DecodedMessage, FieldValue, Frame, MessageDef, Payload } from "./types.ts";

const SIZE: Record<string, number> = {
  char: 1, int8_t: 1, uint8_t: 1, uint8_t_mavlink_version: 1,
  int16_t: 2, uint16_t: 2, int32_t: 4, uint32_t: 4, float: 4,
  int64_t: 8, uint64_t: 8, double: 8,
};

export const STX_V1 = 0xfe;
export const STX_V2 = 0xfd;
const SIGNED_FLAG = 0x01;
const SIGNATURE_LEN = 13;

function readScalar(dv: DataView, off: number, type: string): number | bigint {
  switch (type) {
    case "char":
    case "uint8_t":
    case "uint8_t_mavlink_version": return dv.getUint8(off);
    case "int8_t": return dv.getInt8(off);
    case "uint16_t": return dv.getUint16(off, true);
    case "int16_t": return dv.getInt16(off, true);
    case "uint32_t": return dv.getUint32(off, true);
    case "int32_t": return dv.getInt32(off, true);
    case "float": return dv.getFloat32(off, true);
    case "double": return dv.getFloat64(off, true);
    case "uint64_t": return dv.getBigUint64(off, true);
    case "int64_t": return dv.getBigInt64(off, true);
  }
  throw new Error(`unknown type ${type}`);
}

function writeScalar(dv: DataView, off: number, type: string, v: number | bigint): void {
  switch (type) {
    case "char":
    case "uint8_t":
    case "uint8_t_mavlink_version": dv.setUint8(off, Number(v)); return;
    case "int8_t": dv.setInt8(off, Number(v)); return;
    case "uint16_t": dv.setUint16(off, Number(v), true); return;
    case "int16_t": dv.setInt16(off, Number(v), true); return;
    case "uint32_t": dv.setUint32(off, Number(v), true); return;
    case "int32_t": dv.setInt32(off, Number(v), true); return;
    case "float": dv.setFloat32(off, Number(v), true); return;
    case "double": dv.setFloat64(off, Number(v), true); return;
    case "uint64_t": dv.setBigUint64(off, BigInt(v), true); return;
    case "int64_t": dv.setBigInt64(off, BigInt(v), true); return;
  }
  throw new Error(`unknown type ${type}`);
}

/** Unpack a payload. Short (v2-truncated) payloads are zero-extended first. */
export function unpackPayload(def: MessageDef, raw: Uint8Array): Payload {
  const buf = new Uint8Array(def.maxLen);
  buf.set(raw.subarray(0, def.maxLen));
  const dv = new DataView(buf.buffer);
  const out: Payload = {};
  let off = 0;
  for (const [name, type, arrayLen] of def.fields) {
    const sz = SIZE[type]!;
    if (type === "char") {
      const n = arrayLen || 1;
      let s = "";
      for (let i = 0; i < n; i++) {
        const c = buf[off + i]!;
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      out[name] = s;
      off += n;
    } else if (arrayLen) {
      const arr: (number | bigint)[] = [];
      for (let i = 0; i < arrayLen; i++) arr.push(readScalar(dv, off + i * sz, type));
      out[name] = arr as FieldValue;
      off += sz * arrayLen;
    } else {
      out[name] = readScalar(dv, off, type);
      off += sz;
    }
  }
  return out;
}

/** Pack a payload to full length (all fields, including extensions). Missing fields are 0. */
export function packPayload(def: MessageDef, fields: Partial<Payload>): Uint8Array {
  const buf = new Uint8Array(def.maxLen);
  const dv = new DataView(buf.buffer);
  let off = 0;
  for (const [name, type, arrayLen] of def.fields) {
    const sz = SIZE[type]!;
    const v = fields[name];
    if (type === "char") {
      const n = arrayLen || 1;
      const s = typeof v === "string" ? v : "";
      for (let i = 0; i < n && i < s.length; i++) buf[off + i] = s.charCodeAt(i) & 0xff;
      off += n;
    } else if (arrayLen) {
      const arr = (Array.isArray(v) ? v : []) as (number | bigint)[];
      for (let i = 0; i < arrayLen; i++) writeScalar(dv, off + i * sz, type, arr[i] ?? 0);
      off += sz * arrayLen;
    } else {
      writeScalar(dv, off, type, (v as number | bigint | undefined) ?? 0);
      off += sz;
    }
  }
  return buf;
}

export interface EncodeOptions {
  sysid: number;
  compid: number;
  seq: number;
  /** MAVLink 1 framing (only for messages with id < 256). Default: v2. */
  v1?: boolean;
}

/** Encode one message into a wire frame (unsigned). v2 payloads have trailing zeros trimmed. */
export function encodeFrame(def: MessageDef, fields: Partial<Payload>, opt: EncodeOptions): Uint8Array {
  let payload = packPayload(def, fields);
  if (opt.v1) {
    if (def.id > 255) throw new Error(`${def.name} (id ${def.id}) can't be sent as MAVLink 1`);
    payload = payload.subarray(0, def.minLen);
    const frame = new Uint8Array(6 + payload.length + 2);
    frame.set([STX_V1, payload.length, opt.seq & 0xff, opt.sysid, opt.compid, def.id]);
    frame.set(payload, 6);
    let crc = x25Accumulate(X25_INIT, frame, 1, 6 + payload.length);
    crc = x25AccumulateByte(crc, def.crcExtra);
    frame[6 + payload.length] = crc & 0xff;
    frame[7 + payload.length] = crc >> 8;
    return frame;
  }
  let len = payload.length;
  while (len > 1 && payload[len - 1] === 0) len--;
  payload = payload.subarray(0, len);
  const frame = new Uint8Array(10 + len + 2);
  frame.set([STX_V2, len, 0, 0, opt.seq & 0xff, opt.sysid, opt.compid,
    def.id & 0xff, (def.id >> 8) & 0xff, (def.id >> 16) & 0xff]);
  frame.set(payload, 10);
  let crc = x25Accumulate(X25_INIT, frame, 1, 10 + len);
  crc = x25AccumulateByte(crc, def.crcExtra);
  frame[10 + len] = crc & 0xff;
  frame[11 + len] = crc >> 8;
  return frame;
}

export interface ParserStats {
  frames: number;
  crcErrors: number;
  unknownMsgs: number;
  droppedBytes: number;
}

/**
 * Incremental frame parser. Feed it arbitrary chunks; it calls onFrame for every frame whose
 * CRC checks out. Candidate frames with unknown message ids can't be CRC-checked; they're
 * reported to onUnknown as *unverified* (they may be noise) and the parser advances only one
 * byte. On a CRC failure it also resyncs one byte after the bad STX, so a garbage STX can
 * never swallow the next real frame.
 */
export class FrameParser {
  private buf = new Uint8Array(0);
  readonly stats: ParserStats = { frames: 0, crcErrors: 0, unknownMsgs: 0, droppedBytes: 0 };

  constructor(
    private readonly defs: Record<number, MessageDef>,
    private readonly onFrame: (f: Frame) => void,
    private readonly onUnknown?: (f: Frame) => void,
  ) {}

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    let i = 0;
    while (i < merged.length) {
      const stx = merged[i];
      if (stx !== STX_V1 && stx !== STX_V2) { i++; this.stats.droppedBytes++; continue; }
      const headerLen = stx === STX_V2 ? 10 : 6;
      if (merged.length - i < headerLen) break;
      const len = merged[i + 1]!;
      const incompat = stx === STX_V2 ? merged[i + 2]! : 0;
      const sigLen = incompat & SIGNED_FLAG ? SIGNATURE_LEN : 0;
      const total = headerLen + len + 2 + sigLen;
      if (merged.length - i < total) break;

      const msgid = stx === STX_V2
        ? merged[i + 7]! | (merged[i + 8]! << 8) | (merged[i + 9]! << 16)
        : merged[i + 5]!;
      const frame: Frame = {
        version: stx === STX_V2 ? 2 : 1,
        seq: stx === STX_V2 ? merged[i + 4]! : merged[i + 2]!,
        sysid: stx === STX_V2 ? merged[i + 5]! : merged[i + 3]!,
        compid: stx === STX_V2 ? merged[i + 6]! : merged[i + 4]!,
        msgid,
        payload: merged.slice(i + headerLen, i + headerLen + len),
        signed: sigLen > 0,
      };
      const def = this.defs[msgid];
      if (!def || (incompat & ~SIGNED_FLAG) !== 0) {
        // Can't verify the CRC without CRC_EXTRA (or the frame uses flags we don't understand).
        // Never trust its length: a fake STX inside garbage would make us skip a real frame.
        // Advance one byte; a genuine unknown frame's bytes are then rescanned harmlessly.
        this.stats.unknownMsgs++;
        this.onUnknown?.(frame);
        i += 1;
        continue;
      }
      let crc = x25Accumulate(X25_INIT, merged, i + 1, i + headerLen + len);
      crc = x25AccumulateByte(crc, def.crcExtra);
      const got = merged[i + headerLen + len]! | (merged[i + headerLen + len + 1]! << 8);
      if (crc !== got) {
        this.stats.crcErrors++;
        i += 1;
        continue;
      }
      this.stats.frames++;
      this.onFrame(frame);
      i += total;
    }
    this.buf = merged.slice(i);
  }
}

export function decodeFrame(defs: Record<number, MessageDef>, f: Frame): DecodedMessage | undefined {
  const def = defs[f.msgid];
  if (!def) return undefined;
  return { name: def.name, msgid: f.msgid, sysid: f.sysid, compid: f.compid, seq: f.seq, fields: unpackPayload(def, f.payload) };
}
