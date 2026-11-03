import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FrameParser, decodeFrame, encodeFrame, MESSAGES } from "../src/index.ts";
import type { Frame, MessageDef } from "../src/index.ts";

interface Vector { name: string; id: number; version: "v1" | "v2"; fields: Record<string, unknown>; hex: string }
const data = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors.json", import.meta.url)), "utf8"),
) as { catalog: Record<string, { name: string; crcExtra: number }>; vectors: Vector[] };

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Convert a JSON vector value to what our codec uses for that field type. */
function ours(def: MessageDef, name: string, v: unknown): unknown {
  const f = def.fields.find((x) => x[0] === name);
  if (!f) throw new Error(`${def.name} has no field ${name}`);
  const big = f[1] === "uint64_t" || f[1] === "int64_t";
  const conv = (x: unknown) =>
    big ? BigInt(typeof x === "object" && x !== null ? (x as { bigint: string }).bigint : (x as number)) : x;
  return Array.isArray(v) ? v.map(conv) : conv(v);
}

function parseAll(bytes: Uint8Array): { frames: Frame[]; parser: FrameParser } {
  const frames: Frame[] = [];
  const parser = new FrameParser(MESSAGES, (f) => frames.push(f));
  parser.push(bytes);
  return { frames, parser };
}

describe("generated definitions", () => {
  it("match pymavlink's CRC_EXTRA and names for every message", () => {
    const mismatches: string[] = [];
    for (const [id, ref] of Object.entries(data.catalog)) {
      const def = MESSAGES[Number(id)];
      if (!def) { mismatches.push(`${id} ${ref.name} missing`); continue; }
      if (def.name !== ref.name || def.crcExtra !== ref.crcExtra) {
        mismatches.push(`${id} ${ref.name}: ours ${def.name}/${def.crcExtra}, pymavlink ${ref.crcExtra}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(Object.keys(MESSAGES).length).toBe(Object.keys(data.catalog).length);
  });
});

describe("pymavlink vectors", () => {
  for (const v of data.vectors) {
    const def = MESSAGES[v.id]!;
    const sentFields = Object.fromEntries(
      Object.entries(v.fields).filter(([k]) =>
        v.version === "v2" || !def.fields.find((f) => f[0] === k)![3]),
    );

    it(`decodes ${v.name} ${v.version}`, () => {
      const { frames, parser } = parseAll(hex(v.hex));
      expect(parser.stats.crcErrors).toBe(0);
      expect(frames).toHaveLength(1);
      const msg = decodeFrame(MESSAGES, frames[0]!)!;
      expect(msg.name).toBe(v.name);
      expect(msg.seq).toBe(7);
      for (const [k, val] of Object.entries(sentFields)) {
        const want = ours(def, k, val);
        const got = msg.fields[k];
        if (typeof want === "number" && !Number.isInteger(want)) expect(got).toBeCloseTo(want, 5);
        else expect(got, k).toEqual(want);
      }
    });

    it(`encodes ${v.name} ${v.version} byte-identically`, () => {
      const fields = Object.fromEntries(Object.entries(sentFields).map(([k, val]) => [k, ours(def, k, val)]));
      const frame = encodeFrame(def, fields as never, { sysid: 1, compid: 1, seq: 7, v1: v.version === "v1" });
      expect(toHex(frame)).toBe(v.hex);
    });
  }
});

describe("parser robustness", () => {
  const all = data.vectors.map((v) => hex(v.hex));
  const joinWithGarbage = () => {
    const parts: number[] = [];
    for (const f of all) parts.push(0x00, 0xfd, 0x13, 0xfe, ...f); // fake STX bytes between frames
    // A fake STX can claim up to 280 bytes, so a parser waits for them, as on a live link;
    // trailing idle bytes stand in for the stream continuing.
    parts.push(...new Array(300).fill(0));
    return Uint8Array.from(parts);
  };

  it("finds every frame despite garbage and fake STX bytes", () => {
    const { frames } = parseAll(joinWithGarbage());
    expect(frames).toHaveLength(all.length);
  });

  it("gives the same result however the stream is chunked", () => {
    const bytes = joinWithGarbage();
    let seed = 1;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 20; trial++) {
      const frames: Frame[] = [];
      const p = new FrameParser(MESSAGES, (f) => frames.push(f));
      for (let i = 0; i < bytes.length;) {
        const n = 1 + Math.floor(rand() * 40);
        p.push(bytes.subarray(i, i + n));
        i += n;
      }
      expect(frames).toHaveLength(all.length);
    }
  });

  it("rejects a corrupted frame and still recovers the next one", () => {
    const a = hex(data.vectors.find((v) => v.name === "PARAM_VALUE" && v.version === "v2")!.hex);
    const b = hex(data.vectors.find((v) => v.name === "HEARTBEAT" && v.version === "v2")!.hex);
    const bad = a.slice();
    bad[12] = bad[12]! ^ 0xff;
    const { frames, parser } = parseAll(Uint8Array.from([...bad, ...b]));
    expect(parser.stats.crcErrors).toBeGreaterThanOrEqual(1);
    expect(frames.map((f) => f.msgid)).toEqual([0]);
  });

  it("skips signed-frame signatures", () => {
    const b = hex(data.vectors.find((v) => v.name === "HEARTBEAT" && v.version === "v2")!.hex);
    // Re-frame as signed: set incompat flag, recompute CRC, append 13 signature bytes.
    const def = MESSAGES[0]!;
    const unsigned = encodeFrame(def, decodeFrame(MESSAGES, parseAll(b).frames[0]!)!.fields, { sysid: 1, compid: 1, seq: 7 });
    expect(toHex(unsigned)).toBe(toHex(b));
    const signed = Uint8Array.from([...unsigned, ...new Array(13).fill(0xaa)]);
    signed[2] = 0x01;
    // incompat flags are covered by the CRC, so recompute it
    const { x25Accumulate, x25AccumulateByte, X25_INIT } = require_crc();
    const len = signed[1]!;
    let crc = x25Accumulate(X25_INIT, signed, 1, 10 + len);
    crc = x25AccumulateByte(crc, def.crcExtra);
    signed[10 + len] = crc & 0xff;
    signed[11 + len] = crc >> 8;
    const { frames } = parseAll(Uint8Array.from([...signed, ...b]));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.signed).toBe(true);
  });
});

import * as crcMod from "../src/crc.ts";
function require_crc() { return crcMod; }
