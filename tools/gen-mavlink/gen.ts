/**
 * Generates TypeScript MAVLink definitions from the ArduPilot dialect XML.
 *
 *   npm run gen:mavlink
 *
 * Reads tools/gen-mavlink/xml/ardupilotmega.xml (+ includes) and writes
 * packages/mavlink/src/generated/ardupilotmega.ts.
 *
 * Wire-format rules (MAVLink spec, "Serialization"):
 *  - base fields are sorted by element size, largest first (stable sort);
 *  - extension fields follow in declaration order and are excluded from CRC_EXTRA;
 *  - CRC_EXTRA = x25 over "NAME " + for each base field "type name " (+ array length byte),
 *    folded to one byte: (crc & 0xff) ^ (crc >> 8).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { x25Accumulate, X25_INIT } from "../../packages/mavlink/src/crc.ts";

const here = dirname(fileURLToPath(import.meta.url));
const xmlDir = join(here, "xml");
const outFile = resolve(here, "../../packages/mavlink/src/generated/ardupilotmega.ts");

const TYPE_SIZE: Record<string, number> = {
  char: 1, int8_t: 1, uint8_t: 1, uint8_t_mavlink_version: 1,
  int16_t: 2, uint16_t: 2, int32_t: 4, uint32_t: 4, float: 4,
  int64_t: 8, uint64_t: 8, double: 8,
};

interface FieldDef { name: string; type: string; arrayLen: number; ext: boolean; enum?: string }
interface MsgDef { id: number; name: string; fields: FieldDef[]; crcExtra: number; minLen: number; maxLen: number }
interface EnumDef { name: string; bitmask: boolean; entries: { name: string; value: number }[] }

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  preserveOrder: true,
  textNodeName: "#text",
});

type Node = Record<string, unknown> & { ":@"?: Record<string, string> };

function children(node: Node, tag: string): Node[] {
  const kids = (node[tag] as Node[]) ?? [];
  return kids;
}
function attrs(node: Node): Record<string, string> {
  return node[":@"] ?? {};
}
function tagOf(node: Node): string | undefined {
  return Object.keys(node).find((k) => k !== ":@");
}

const messages = new Map<number, MsgDef>();
const enums = new Map<string, EnumDef>();
const seen = new Set<string>();

function parseFile(file: string) {
  if (seen.has(file)) return;
  seen.add(file);
  const doc = parser.parse(readFileSync(join(xmlDir, file), "utf8")) as Node[];
  const root = doc.find((n) => tagOf(n) === "mavlink");
  if (!root) throw new Error(`${file}: no <mavlink> root`);
  for (const section of children(root, "mavlink")) {
    const tag = tagOf(section);
    if (tag === "include") {
      const inc = (children(section, "include")[0]?.["#text"] as string).trim();
      parseFile(inc);
    } else if (tag === "enums") {
      for (const e of children(section, "enums")) {
        if (tagOf(e) !== "enum") continue;
        const a = attrs(e);
        const def = enums.get(a.name!) ?? { name: a.name!, bitmask: a.bitmask === "true", entries: [] };
        for (const entry of children(e, "enum")) {
          if (tagOf(entry) !== "entry") continue;
          const ea = attrs(entry);
          if (ea.value === undefined) continue;
          if (!def.entries.some((x) => x.name === ea.name)) {
            def.entries.push({ name: ea.name!, value: Number(ea.value) });
          }
        }
        enums.set(def.name, def);
      }
    } else if (tag === "messages") {
      for (const m of children(section, "messages")) {
        if (tagOf(m) !== "message") continue;
        const a = attrs(m);
        const fields: FieldDef[] = [];
        let ext = false;
        for (const f of children(m, "message")) {
          const ft = tagOf(f);
          if (ft === "extensions") { ext = true; continue; }
          if (ft !== "field") continue;
          const fa = attrs(f);
          const match = /^([a-z0-9_]+?)(?:\[(\d+)\])?$/.exec(fa.type!);
          if (!match) throw new Error(`bad type ${fa.type}`);
          fields.push({
            name: fa.name!,
            type: match[1]!,
            arrayLen: match[2] ? Number(match[2]) : 0,
            ext,
            ...(fa.enum ? { enum: fa.enum } : {}),
          });
        }
        const id = Number(a.id);
        messages.set(id, finish(id, a.name!, fields));
      }
    }
  }
}

function finish(id: number, name: string, declared: FieldDef[]): MsgDef {
  const base = declared.filter((f) => !f.ext);
  const ext = declared.filter((f) => f.ext);
  const sorted = base
    .map((f, i) => ({ f, i }))
    .sort((a, b) => TYPE_SIZE[b.f.type]! - TYPE_SIZE[a.f.type]! || a.i - b.i)
    .map((x) => x.f);
  const fields = [...sorted, ...ext];

  let crc = X25_INIT;
  const enc = new TextEncoder();
  crc = x25Accumulate(crc, enc.encode(name + " "));
  for (const f of sorted) {
    const t = f.type === "uint8_t_mavlink_version" ? "uint8_t" : f.type;
    crc = x25Accumulate(crc, enc.encode(t + " "));
    crc = x25Accumulate(crc, enc.encode(f.name + " "));
    if (f.arrayLen) crc = x25Accumulate(crc, new Uint8Array([f.arrayLen]));
  }
  const crcExtra = (crc & 0xff) ^ (crc >> 8);
  const len = (fs: FieldDef[]) => fs.reduce((s, f) => s + TYPE_SIZE[f.type]! * (f.arrayLen || 1), 0);
  return { id, name, fields, crcExtra, minLen: len(sorted), maxLen: len(fields) };
}

parseFile("ardupilotmega.xml");

// ---- emit ----
const tsType = (f: FieldDef): string => {
  if (f.type === "char") return "string";
  const scalar = f.type === "int64_t" || f.type === "uint64_t" ? "bigint" : "number";
  return f.arrayLen ? `${scalar}[]` : scalar;
};
const pascal = (s: string) => s.toLowerCase().replace(/(^|_)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

const sortedMsgs = [...messages.values()].sort((a, b) => a.id - b.id);
let out = `// AUTO-GENERATED by tools/gen-mavlink/gen.ts from ArduPilot's ardupilotmega.xml. Do not edit.\n`;
out += `import type { MessageDef } from "../types.ts";\n\n`;
out += `export const MESSAGES: Record<number, MessageDef> = {\n`;
for (const m of sortedMsgs) {
  const fs = m.fields
    .map((f) => `[${JSON.stringify(f.name)},${JSON.stringify(f.type)},${f.arrayLen},${f.ext ? 1 : 0}]`)
    .join(",");
  out += `  ${m.id}: { id: ${m.id}, name: ${JSON.stringify(m.name)}, crcExtra: ${m.crcExtra}, minLen: ${m.minLen}, maxLen: ${m.maxLen}, fields: [${fs}] },\n`;
}
out += `};\n\n`;
out += `export const MSG_ID = {\n${sortedMsgs.map((m) => `  ${m.name}: ${m.id},`).join("\n")}\n} as const;\n\n`;
for (const m of sortedMsgs) {
  out += `export interface ${pascal(m.name)} {\n`;
  for (const f of m.fields) out += `  ${f.name}${f.ext ? "?" : ""}: ${tsType(f)};\n`;
  out += `}\n`;
}
out += `\nexport interface MessageMap {\n${sortedMsgs.map((m) => `  ${m.name}: ${pascal(m.name)};`).join("\n")}\n}\n\n`;
for (const e of [...enums.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  out += `export const ${e.name} = {\n${e.entries.map((x) => `  ${x.name}: ${x.value},`).join("\n")}\n} as const;\n`;
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, out);
console.log(`wrote ${sortedMsgs.length} messages, ${enums.size} enums -> ${outFile}`);
