/**
 * Peripherals: which device is on which serial port (like Betaflight's / INAV's Ports tab), plus
 * decoding the sensor IDs ArduPilot stores for devices it found on I2C/SPI/CAN by itself.
 */
import type { Profile } from "./types.ts";

export type PeripheralKind =
  | "keep" | "none" | "rc-elrs" | "rc" | "rc-mavlink" | "mavlink" | "gps" | "esc-telem" | "displayport" | "scripting";

export interface PeripheralInfo { label: string; protocol: number; baud?: number; help: string }

export const PERIPHERALS: Record<Exclude<PeripheralKind, "keep">, PeripheralInfo> = {
  none: { label: "Nothing", protocol: -1, help: "Port off." },
  "rc-elrs": { label: "RC receiver: ExpressLRS", protocol: 23, help: "ELRS (CRSF protocol at 420k). Wire both TX and RX." },
  rc: { label: "RC receiver: other (Crossfire, SBUS, FPort…)", protocol: 23, help: "ArduPilot detects the protocol by itself." },
  "rc-mavlink": { label: "ELRS receiver in MAVLink mode", protocol: 2, baud: 460, help: "RC and telemetry on one link (ELRS 3.5+ MAVLink mode)." },
  mavlink: { label: "Telemetry (MAVLink)", protocol: 2, baud: 57, help: "Telemetry radio, WiFi bridge or companion computer." },
  gps: { label: "GPS", protocol: 5, baud: 230, help: "ArduPilot finds the GPS's type and baud by itself." },
  "esc-telem": { label: "ESC telemetry wire", protocol: 16, baud: 115, help: "BLHeli32 / AM32 telemetry wire on this port's RX pad." },
  displayport: { label: "OSD / HD video (MSP DisplayPort)", protocol: 42, baud: 115, help: "DJI / Walksnail / HDZero OSD." },
  scripting: { label: "Lua script serial device", protocol: 28, baud: 115, help: "A team script talks to a device on this port." },
};

export const PROTOCOL_TO_KIND: Record<number, PeripheralKind> = { [-1]: "none", 2: "mavlink", 1: "mavlink", 5: "gps", 16: "esc-telem", 23: "rc", 42: "displayport", 28: "scripting" };

/** What each SERIALn is set to now, as profile port entries (others = "keep"). */
export function portsFromBoard(params: ReadonlyMap<string, number>): Record<string, PeripheralKind> {
  const out: Record<string, PeripheralKind> = {};
  for (let n = 1; n <= 8; n++) {
    const pr = params.get(`SERIAL${n}_PROTOCOL`);
    if (pr === undefined) continue;
    out[n] = PROTOCOL_TO_KIND[pr] ?? "keep";
  }
  if (((params.get("RC_OPTIONS") ?? 0) >> 13) & 1) for (const [n, k] of Object.entries(out)) if (k === "rc") out[n] = "rc-elrs";
  // an ELRS MAVLink receiver looks like plain MAVLink; RSSI_TYPE 5 (receiver over MAVLink) tells them apart
  if (params.get("RSSI_TYPE") === 5) {
    const first = Object.entries(out).find(([, k]) => k === "mavlink");
    if (first) out[first[0]] = "rc-mavlink";
  }
  return out;
}

/** Ports for a profile (older profiles stored only a receiver and an ESC telemetry serial). */
export function profilePorts(p: Profile): Record<string, PeripheralKind> {
  if (p.ports) return p.ports;
  const out: Record<string, PeripheralKind> = {};
  if (p.receiver.serial !== undefined && (p.receiver.kind === "elrs-crsf" || p.receiver.kind === "elrs-mavlink")) {
    out[p.receiver.serial] = p.receiver.kind === "elrs-crsf" ? "rc-elrs" : "rc-mavlink";
  }
  for (const m of p.motors) if (m.telemetry === "serial" && m.telemetrySerial) out[m.telemetrySerial] = "esc-telem";
  return out;
}

/** Pad label for SERIALn from the board's SERIAL_ORDER, e.g. "UART7 (TX7/RX7)". */
export function padLabel(n: number, serialOrder?: string[]): string {
  const uart = serialOrder?.[n];
  if (!uart) return "";
  if (uart.startsWith("OTG")) return uart === "OTG1" ? "USB" : "USB (2nd)";
  const k = uart.replace(/^U?S?ART/, "");
  return `${uart} (TX${k}/RX${k})`;
}

// ---- sensor device IDs ----

const BUS = ["?", "I2C", "SPI", "DroneCAN", "SITL", "MSP", "serial", "QSPI"];
const COMPASS_TYPES: Record<number, string> = {
  0x05: "BMM150", 0x07: "HMC5883", 0x08: "LIS3MDL", 0x09: "AK09916", 0x0a: "IST8310", 0x0d: "QMC5883L",
  0x0f: "simulated", 0x11: "RM3100", 0x13: "MMC5883",
};

export interface DeviceId { busType: string; bus: number; address: number; devtype: number; name?: string }

/** Decode an ArduPilot device id (AP_HAL::Device bus_type | bus<<3 | address<<8 | devtype<<16). */
export function decodeDevId(id: number, kind?: "compass"): DeviceId | undefined {
  if (!id) return undefined;
  const v = id >>> 0;
  const devtype = (v >>> 16) & 0xff;
  return {
    busType: BUS[v & 0x7] ?? "?", bus: (v >>> 3) & 0x1f, address: (v >>> 8) & 0xff, devtype,
    name: kind === "compass" ? COMPASS_TYPES[devtype] : undefined,
  };
}

export interface FoundSensor { role: string; param: string; dev: DeviceId; enabled?: boolean }

/** Sensors the board found on its own (from *_DEVID / *_ID parameters). */
export function foundSensors(params: ReadonlyMap<string, number>): FoundSensor[] {
  const out: FoundSensor[] = [];
  const add = (role: string, param: string, kind?: "compass", enabled?: boolean) => {
    const d = decodeDevId(params.get(param) ?? 0, kind);
    if (d) out.push({ role, param, dev: d, enabled });
  };
  add("IMU 1", "INS_ACC_ID"); add("IMU 2", "INS_ACC2_ID"); add("IMU 3", "INS_ACC3_ID");
  add("Barometer 1", "BARO1_DEVID"); add("Barometer 2", "BARO2_DEVID");
  add("Compass 1", "COMPASS_DEV_ID", "compass", params.get("COMPASS_USE") === 1);
  add("Compass 2", "COMPASS_DEV_ID2", "compass", params.get("COMPASS_USE2") === 1);
  add("Compass 3", "COMPASS_DEV_ID3", "compass", params.get("COMPASS_USE3") === 1);
  add("Airspeed", "ARSPD_DEVID");
  return out;
}

export function describeDev(d: DeviceId): string {
  const where = d.busType === "I2C" ? `I2C bus ${d.bus}, address 0x${d.address.toString(16).padStart(2, "0")}`
    : d.busType === "SPI" ? `SPI bus ${d.bus}` : d.busType === "DroneCAN" ? `DroneCAN node ${d.address}` : d.busType;
  return `${d.name ? `${d.name} on ` : ""}${where}`;
}
