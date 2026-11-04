/**
 * Session: everything the UI needs about one connected vehicle, as a subscribable store.
 *
 * Safety rules enforced here (not in the UI), so no screen can bypass them:
 *  - every connection takes a full parameter backup before anything can be written;
 *  - nothing is written while the vehicle reports armed, or after the link is lost;
 *  - every write is echo-verified and reported per parameter.
 */
import { MavConnection } from "./connection.ts";
import { ParamManager, type Param, type SetResult } from "./params.ts";
import { MavFtp, parseParamPck } from "./ftp.ts";
import type { Transport } from "./transport.ts";
import type { BackupRecord, BackupStore } from "./backupStore.ts";

export type Phase = "disconnected" | "connecting" | "identifying" | "downloading" | "backing-up" | "ready" | "lost" | "error";

export interface VehicleInfo {
  sysid: number;
  mavType: number;
  autopilot: number;
  firmware: string;          // "4.7.2"
  firmwareType: string;      // "official", "beta", "dev"…
  git: string;
  target?: string;           // "MatekH743-bdshot" (from the boot banner)
  boardId: number;           // APJ board id
  uid: string;               // uid2 hex (falls back to uid)
}

export interface LogLine { t: number; severity: number; text: string }

export interface SessionState {
  phase: Phase;
  error?: string;
  link?: string;
  info?: VehicleInfo;
  armed: boolean;
  mode: number;
  /** bumps whenever params change, so React can memo on it */
  paramsRev: number;
  backup?: BackupRecord;
  busy?: { label: string; done: number; total: number };
  log: LogLine[];
  rebootNeeded: string[];
}

export interface LiveState {
  /** RC_CHANNELS raw PWM, index 0 = channel 1 */
  rc: number[];
  rcCount: number;
  rssi?: number;
  /** SERVO_OUTPUT_RAW, index 0 = S1 */
  servo: number[];
  attitude?: { roll: number; pitch: number; yaw: number };
  /** husky.lua heartbeat */
  hsk?: { version: number; state: number; t: number };
  /** GPS_RAW_INT: fix type (0 no GPS, 1 no fix, 2 2D, 3 3D…) and satellites */
  gps?: { fix: number; sats: number; t: number };
  /** last time ESC telemetry arrived */
  escT?: number;
}

export interface Hwdef { text: string; pwm: { n: number; timer: string; bidir: boolean }[]; serialOrder: string[] }

export interface WriteChange { name: string; value: number }
export interface WriteReport { results: SetResult[]; ok: boolean; aborted?: string }

const FW_TYPE: Record<number, string> = { 0: "dev", 64: "alpha", 128: "beta", 192: "rc", 255: "official" };

export class Session {
  private state: SessionState = { phase: "disconnected", armed: false, mode: 0, paramsRev: 0, log: [], rebootNeeded: [] };
  private subs = new Set<() => void>();
  conn?: MavConnection;
  pm?: ParamManager;
  ftp?: MavFtp;
  private hbWatch?: ReturnType<typeof setInterval>;
  private opener?: () => Promise<Transport>;
  private lastHb = 0;

  constructor(private readonly backups: BackupStore, private readonly opts: { rebootRequired?: (name: string) => boolean } = {}) {}

  // ---- store plumbing (works with React's useSyncExternalStore) ----
  get snapshot(): SessionState { return this.state; }
  subscribe = (cb: () => void) => { this.subs.add(cb); return () => { this.subs.delete(cb); }; };
  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.subs.forEach((cb) => cb());
  }
  private logLine(severity: number, text: string) {
    this.set({ log: [...this.state.log.slice(-299), { t: Date.now(), severity, text }] });
  }

  get params(): ReadonlyMap<string, Param> { return this.pm?.params ?? new Map(); }
  get canWrite(): boolean {
    return this.state.phase === "ready" && !this.state.armed && !!this.state.backup;
  }

  // ---- connect ----
  /** Connect with a function that opens the link, so the session can reopen it after a reboot. */
  async connect(open: Transport | (() => Promise<Transport>)): Promise<void> {
    await this.disconnect();
    this.opener = typeof open === "function" ? open : undefined;
    let transport: Transport;
    try {
      transport = typeof open === "function" ? await open() : open;
    } catch (e) {
      this.set({ phase: "error", error: (e as Error).message });
      return;
    }
    this.set({ phase: "connecting", error: undefined, link: transport.description, info: undefined, backup: undefined,
      busy: undefined, rebootNeeded: [], log: [] });
    await this.attach(transport, { backup: true });
  }

  private async attach(transport: Transport, opt: { backup: boolean }): Promise<void> {
    try {
      const conn = new MavConnection(transport);
      this.conn = conn;
      transport.onClose((e) => this.onLinkClosed(e));
      conn.on("STATUSTEXT", (m) => this.logLine(m.fields.severity, m.fields.text));
      conn.on("HEARTBEAT", (m) => {
        if (m.sysid !== conn.target.sysid || m.compid !== 1) return;
        this.lastHb = Date.now();
        const armed = (m.fields.base_mode & 128) !== 0;
        const patch: Partial<SessionState> = {};
        if (armed !== this.state.armed) patch.armed = armed;
        if (m.fields.custom_mode !== this.state.mode) patch.mode = m.fields.custom_mode;
        if (this.state.phase === "lost") patch.phase = "ready";
        if (Object.keys(patch).length) this.set(patch);
      });
      await conn.ready(8000);
      this.lastHb = Date.now();

      this.set({ phase: "identifying" });
      const info = await this.identify(conn);
      this.set({ info });

      this.set({ phase: "downloading" });
      this.pm = new ParamManager(conn);
      this.ftp = new MavFtp(conn);
      await this.downloadParams();

      if (opt.backup || !this.state.backup) {
        this.set({ phase: "backing-up" });
        await this.saveBackup("automatic, on connect");
      }
      this.startLive(conn);
      this.set({ phase: "ready", busy: undefined });
      void this.readHwdef();

      this.hbWatch = setInterval(() => {
        if (this.state.phase === "ready" && Date.now() - this.lastHb > 3500) this.set({ phase: "lost" });
      }, 500);
    } catch (e) {
      this.set({ phase: "error", error: (e as Error).message, busy: undefined });
      await this.conn?.close().catch(() => {});
      this.conn = undefined;
    }
  }

  private async identify(conn: MavConnection): Promise<VehicleInfo> {
    const hb = conn.lastHeartbeat!.fields;
    let target: string | undefined;
    const off = conn.on("STATUSTEXT", (m) => {
      // banner line: "<target> <uid words…>", e.g. "MatekH743-bdshot 0039004F 35325107 38363832"
      const t = /^([A-Za-z0-9_-]+) [0-9A-F]{8}( [0-9A-F]{8})+$/.exec(m.fields.text);
      if (t) target = t[1];
    });
    const verWait = conn.waitFor("AUTOPILOT_VERSION", () => true, 3000);
    await conn.send("COMMAND_LONG", { target_system: conn.target.sysid, target_component: conn.target.compid, command: 512, param1: 148 });
    const v = (await verWait).fields;
    await conn.command(42428).catch(() => 0); // MAV_CMD_DO_SEND_BANNER
    await new Promise((r) => setTimeout(r, 600));
    off();
    const fw = v.flight_sw_version;
    const uid2 = (v.uid2 ?? []).some((b) => b) ? (v.uid2 ?? []).map((b) => b.toString(16).padStart(2, "0")).join("").replace(/(00)+$/, "") : "";
    return {
      sysid: conn.target.sysid, mavType: hb.type, autopilot: hb.autopilot,
      firmware: `${(fw >> 24) & 0xff}.${(fw >> 16) & 0xff}.${(fw >> 8) & 0xff}`,
      firmwareType: FW_TYPE[fw & 0xff] ?? String(fw & 0xff),
      git: String.fromCharCode(...v.flight_custom_version.filter((c) => c)),
      target, boardId: v.board_version >>> 16, uid: uid2 || String(v.uid),
    };
  }

  /** Full download: MAVFTP param.pck (fast), falling back to the parameter protocol. */
  async downloadParams(): Promise<void> {
    const pm = this.pm!;
    try {
      this.set({ busy: { label: "Reading parameters (fast)", done: 0, total: 1 } });
      await this.ftp!.resetSessions();
      const bytes = await this.ftp!.read("@PARAM/param.pck", (d, t) => this.set({ busy: { label: "Reading parameters (fast)", done: d, total: t } }));
      pm.loadAll(parseParamPck(bytes));
    } catch (e) {
      this.logLine(5, `Fast parameter read unavailable (${(e as Error).message}); using the slow method`);
      await pm.download({ onProgress: (p) => this.set({ busy: { label: "Reading parameters", done: p.received, total: p.total } }) });
    }
    this.set({ paramsRev: this.state.paramsRev + 1, busy: undefined });
  }

  async saveBackup(reason: string): Promise<BackupRecord> {
    const info = this.state.info!;
    const b: BackupRecord = {
      id: `${info.uid}-${new Date().toISOString()}`,
      savedAt: new Date().toISOString(), reason,
      boardUid: info.uid, target: info.target ?? `board ${info.boardId}`, firmware: info.firmware,
      params: [...this.params.values()].map((p) => ({ name: p.name, value: p.value, type: p.type })),
    };
    await this.backups.put(b);
    this.set({ backup: b });
    return b;
  }

  listBackups() { return this.backups.list(this.state.info?.uid); }
  getBackup(id: string) { return this.backups.get(id); }

  // ---- writing ----
  /**
   * Write a set of changes. Refuses unless a backup exists and the vehicle is disarmed.
   * Stops at the first armed heartbeat or lost link. Reports every parameter's outcome.
   */
  async write(changes: WriteChange[], label = "Writing parameters"): Promise<WriteReport> {
    if (!this.canWrite) {
      const why = this.state.armed ? "vehicle is armed" : !this.state.backup ? "no backup yet" : `not ready (${this.state.phase})`;
      return { results: [], ok: false, aborted: `Refused: ${why}` };
    }
    const results: SetResult[] = [];
    let aborted: string | undefined;
    const needReboot = new Set(this.state.rebootNeeded);
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i]!;
      if (this.state.armed) { aborted = "Stopped: vehicle armed"; break; }
      if (this.state.phase !== "ready") { aborted = "Stopped: link lost"; break; }
      this.set({ busy: { label, done: i, total: changes.length } });
      const r = await this.pm!.set(c.name, c.value);
      results.push(r);
      if (r.ok && this.opts.rebootRequired?.(c.name)) needReboot.add(c.name);
    }
    this.set({ busy: undefined, paramsRev: this.state.paramsRev + 1, rebootNeeded: [...needReboot] });
    return { results, ok: !aborted && results.every((r) => r.ok), aborted };
  }

  /** MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN. The link drops; the caller reconnects. */
  async reboot(): Promise<void> {
    if (this.state.armed) throw new Error("vehicle is armed");
    await this.conn?.command(246, [1]).catch(() => {});
    this.set({ rebootNeeded: [] });
  }

  // ---- live telemetry (separate store: it changes ~10x a second) ----
  private liveState: LiveState = { rc: [], rcCount: 0, servo: [] };
  private liveSubs = new Set<() => void>();
  get live(): LiveState { return this.liveState; }
  subscribeLive = (cb: () => void) => { this.liveSubs.add(cb); return () => { this.liveSubs.delete(cb); }; };
  private setLive(patch: Partial<LiveState>) {
    this.liveState = { ...this.liveState, ...patch };
    this.liveSubs.forEach((cb) => cb());
  }

  private startLive(conn: MavConnection) {
    conn.on("RC_CHANNELS", (m) => {
      const f = m.fields as unknown as Record<string, number>;
      this.setLive({ rc: Array.from({ length: 18 }, (_, i) => f[`chan${i + 1}_raw`] ?? 0), rcCount: f.chancount ?? 0, rssi: f.rssi });
    });
    conn.on("SERVO_OUTPUT_RAW", (m) => {
      const f = m.fields as unknown as Record<string, number>;
      if ((f.port ?? 0) !== 0) return;
      this.setLive({ servo: Array.from({ length: 16 }, (_, i) => f[`servo${i + 1}_raw`] ?? 0) });
    });
    conn.on("GPS_RAW_INT", (m) => this.setLive({ gps: { fix: m.fields.fix_type, sats: m.fields.satellites_visible, t: Date.now() } }));
    conn.on("ESC_TELEMETRY_1_TO_4", () => this.setLive({ escT: Date.now() }));
    conn.on("ATTITUDE", (m) => this.setLive({ attitude: { roll: m.fields.roll, pitch: m.fields.pitch, yaw: m.fields.yaw } }));
    conn.on("NAMED_VALUE_FLOAT", (m) => {
      if (m.fields.name !== "HSK") return;
      const v = Math.round(m.fields.value);
      this.setLive({ hsk: { version: Math.floor(v / 100), state: v % 100, t: Date.now() } });
    });
    // ask for what the wizard watches (best effort)
    for (const [id, hz] of [[65, 10], [36, 10], [30, 10], [24, 2]] as const) void conn.setMessageRate(id, hz).catch(() => {});
  }

  /** Board hardware definition from ROMFS (exact for the running firmware), if the board has one. */
  hwdef?: Hwdef;
  private async readHwdef() {
    try {
      const bytes = await this.ftp!.read("@ROMFS/hwdef.dat");
      this.hwdef = parseHwdef(new TextDecoder().decode(bytes));
    } catch { this.hwdef = undefined; }
    this.set({ paramsRev: this.state.paramsRev + 1 });
  }

  /** MAV_CMD_DO_SET_MODE with a Plane custom mode number. */
  async setMode(mode: number): Promise<boolean> {
    if (!this.conn) return false;
    return (await this.conn.command(176, [1, mode])) === 0;
  }

  private overrideTimer?: ReturnType<typeof setInterval>;
  /** Hold RC channels (1-based) at these PWMs, refreshed at 20 Hz, until stopOverride(). Disarmed only. */
  startOverride(ch: Record<number, number>) {
    if (this.state.armed) throw new Error("vehicle is armed");
    if (!this.conn) throw new Error("not connected");
    clearInterval(this.overrideTimer);
    const send = () => {
      const c = this.conn;
      if (!c) return;
      const f: Record<string, number> = { target_system: c.target.sysid, target_component: c.target.compid };
      // 0 = "release this channel" for 1-8; for 9-18 0 also means release in ArduPilot
      for (let i = 1; i <= 18; i++) f[`chan${i}_raw`] = ch[i] ?? 0;
      void c.send("RC_CHANNELS_OVERRIDE", f as never).catch(() => {});
    };
    send();
    this.overrideTimer = setInterval(send, 50);
  }
  async stopOverride() {
    clearInterval(this.overrideTimer);
    this.overrideTimer = undefined;
    const c = this.conn;
    if (c) await c.send("RC_CHANNELS_OVERRIDE", { target_system: c.target.sysid, target_component: c.target.compid }).catch(() => {});
  }

  private rebooting = false;
  /** Reboot and reopen the same link, re-reading params. Keeps this session's backup. */
  async rebootAndReconnect(label = "Rebooting the board"): Promise<void> {
    if (this.state.armed) throw new Error("vehicle is armed");
    if (!this.opener) throw new Error("this link can't be reopened automatically; reconnect by hand");
    const keepBackup = this.state.backup;
    const keepInfo = this.state.info;
    this.rebooting = true;
    this.set({ busy: { label, done: 0, total: 1 } });
    await this.conn?.command(246, [1], { retries: 1 }).catch(() => {});
    clearInterval(this.hbWatch);
    clearInterval(this.overrideTimer);
    await this.conn?.close().catch(() => {});
    this.conn = undefined;
    this.set({ phase: "connecting", busy: { label, done: 0, total: 1 } });
    const t0 = Date.now();
    let lastErr: unknown;
    while (Date.now() - t0 < 60000) {
      await new Promise((r) => setTimeout(r, 2000));
      let t: Transport;
      try { t = await this.opener(); } catch (e) { lastErr = e; continue; }
      this.set({ backup: keepBackup, info: keepInfo, rebootNeeded: [] });
      await this.attach(t, { backup: false });
      if (this.state.phase === "ready") { this.rebooting = false; return; }
      lastErr = new Error(this.state.error);
    }
    this.rebooting = false;
    this.set({ phase: "error", error: `The board didn't come back after the reboot. ${(lastErr as Error)?.message ?? ""}`, busy: undefined });
  }

  /** Upload a script to the board's scripts folder over MAVLink FTP and verify by reading it back. */
  async uploadScript(name: string, source: string): Promise<string> {
    if (!this.canWrite) throw new Error("writing is locked (armed, no backup, or not connected)");
    const bytes = new TextEncoder().encode(source);
    const sitl = this.params.has("SIM_RC_FAIL");
    const dir = sitl ? "scripts" : "/APM/scripts";
    this.set({ busy: { label: `Uploading ${name}`, done: 0, total: 1 } });
    try {
      if (!sitl) await this.ftp!.mkdir("/APM");
      await this.ftp!.mkdir(dir);
      const path = `${dir}/${name}`;
      await this.ftp!.write(path, bytes);
      const back = await this.ftp!.read(path);
      if (back.length !== bytes.length || back.some((b, i) => b !== bytes[i])) throw new Error("read-back didn't match what was written");
      return path;
    } finally {
      this.set({ busy: undefined });
    }
  }

  /** True when talking to ArduPilot's simulator. */
  get isSitl(): boolean { return this.params.has("SIM_RC_FAIL"); }

  private onLinkClosed(e?: Error) {
    if (this.rebooting) return;
    if (this.state.phase === "disconnected") return;
    clearInterval(this.hbWatch);
    this.set({ phase: "disconnected", error: e?.message, busy: undefined });
    this.conn = undefined;
  }

  async disconnect(): Promise<void> {
    clearInterval(this.hbWatch);
    clearInterval(this.overrideTimer);
    this.opener = undefined;
    const c = this.conn;
    this.conn = undefined;
    this.set({ phase: "disconnected", busy: undefined });
    await c?.close().catch(() => {});
  }
}

/** Parse an ArduPilot hwdef.dat: PWM outputs with their timers (later lines win, as in the
 *  -bdshot variants that redefine pins) and the SERIAL_ORDER. */
export function parseHwdef(text: string): Hwdef {
  const pwm = new Map<number, { n: number; timer: string; bidir: boolean }>();
  let serialOrder: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const so = /^SERIAL_ORDER\s+(.+)$/.exec(line);
    if (so) serialOrder = so[1]!.split(/\s+/);
    const m = /^P[A-K]\d+\s+\S+\s+(TIM\d+)\s+PWM\((\d+)\)(.*)$/.exec(line);
    if (m) pwm.set(Number(m[2]), { n: Number(m[2]), timer: m[1]!, bidir: /\bBIDIR\b/.test(m[3]!) });
  }
  return { text, pwm: [...pwm.values()].sort((a, b) => a.n - b.n), serialOrder };
}
