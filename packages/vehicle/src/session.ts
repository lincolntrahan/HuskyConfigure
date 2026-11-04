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
  async connect(transport: Transport): Promise<void> {
    await this.disconnect();
    this.set({ phase: "connecting", error: undefined, link: transport.description, info: undefined, backup: undefined,
      busy: undefined, rebootNeeded: [], log: [] });
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

      this.set({ phase: "backing-up" });
      await this.saveBackup("automatic, on connect");
      this.set({ phase: "ready", busy: undefined });

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

  private onLinkClosed(e?: Error) {
    if (this.state.phase === "disconnected") return;
    clearInterval(this.hbWatch);
    this.set({ phase: "disconnected", error: e?.message, busy: undefined });
    this.conn = undefined;
  }

  async disconnect(): Promise<void> {
    clearInterval(this.hbWatch);
    const c = this.conn;
    this.conn = undefined;
    this.set({ phase: "disconnected", busy: undefined });
    await c?.close().catch(() => {});
  }
}
