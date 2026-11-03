import type { MavConnection } from "./connection.ts";

export interface Param {
  name: string;
  value: number;
  /** MAV_PARAM_TYPE */
  type: number;
  index: number;
}

export interface DownloadProgress { received: number; total: number; round: number }

export interface DownloadOptions {
  /** Stream considered finished after this long with no new PARAM_VALUE. */
  idleMs?: number;
  /** Max gap-fill rounds (each re-requests every missing index). */
  maxRounds?: number;
  onProgress?: (p: DownloadProgress) => void;
}

export interface SetResult {
  name: string;
  requested: number;
  /** Value the vehicle echoed back (undefined if it never answered). */
  echoed?: number;
  ok: boolean;
  attempts: number;
}

const enc = (name: string) => name.slice(0, 16);

/** Values travel as float32 (ArduPilot uses C-cast encoding), so compare after rounding to float32. */
export function sameParamValue(a: number, b: number): boolean {
  return Math.fround(a) === Math.fround(b);
}

/**
 * Parameter download/upload for one vehicle.
 * - download(): PARAM_REQUEST_LIST, then re-requests missing indices by PARAM_REQUEST_READ.
 * - set(): PARAM_SET, waits for the echoed PARAM_VALUE, retries, and reports whether the
 *   vehicle actually holds the requested value. Never reports success it didn't observe.
 */
export class ParamManager {
  readonly params = new Map<string, Param>();
  private byIndex = new Map<number, Param>();
  total = 0;

  constructor(private readonly conn: MavConnection) {
    conn.on("PARAM_VALUE", (m) => {
      const f = m.fields;
      if (m.sysid !== conn.target.sysid) return;
      const p: Param = { name: f.param_id, value: f.param_value, type: f.param_type, index: f.param_index };
      const known = this.params.get(p.name);
      // Index 65535 is used for set acks; keep the index we learned from the list.
      if (p.index === 65535 && known) p.index = known.index;
      this.params.set(p.name, p);
      if (p.index !== 65535) this.byIndex.set(p.index, p);
      if (f.param_count && f.param_count !== 65535) this.total = f.param_count;
    });
  }

  private get t() { return { target_system: this.conn.target.sysid, target_component: this.conn.target.compid }; }

  async download(opt: DownloadOptions = {}): Promise<Map<string, Param>> {
    const idleMs = opt.idleMs ?? 700;
    const maxRounds = opt.maxRounds ?? 5;
    this.byIndex.clear();
    this.total = 0;
    await this.conn.send("PARAM_REQUEST_LIST", this.t);
    await this.waitIdle(idleMs, (r) => opt.onProgress?.({ received: r, total: this.total, round: 0 }));

    for (let round = 1; round <= maxRounds; round++) {
      const missing = this.missing();
      if (this.total && missing.length === 0) break;
      if (!this.total) {
        await this.conn.send("PARAM_REQUEST_LIST", this.t);
      } else {
        for (const idx of missing) {
          await this.conn.send("PARAM_REQUEST_READ", { ...this.t, param_id: "", param_index: idx });
        }
      }
      await this.waitIdle(idleMs, (r) => opt.onProgress?.({ received: r, total: this.total, round }));
    }
    const missing = this.missing();
    if (!this.total || missing.length) {
      throw new Error(`param download incomplete: ${this.byIndex.size}/${this.total} (missing ${missing.slice(0, 10).join(",")}…)`);
    }
    return this.params;
  }

  missing(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.total; i++) if (!this.byIndex.has(i)) out.push(i);
    return out;
  }

  private waitIdle(idleMs: number, progress: (received: number) => void): Promise<void> {
    return new Promise((resolve) => {
      let timer = setTimeout(done, idleMs * 3); // allow a slow first packet
      const off = this.conn.on("PARAM_VALUE", () => {
        clearTimeout(timer);
        progress(this.byIndex.size);
        timer = setTimeout(done, idleMs);
      });
      function done() { off(); resolve(); }
    });
  }

  /** Re-read one parameter from the vehicle. */
  async read(name: string, timeoutMs = 1500): Promise<Param> {
    const wait = this.conn.waitFor("PARAM_VALUE", (m) => m.fields.param_id === enc(name), timeoutMs);
    await this.conn.send("PARAM_REQUEST_READ", { ...this.t, param_id: enc(name), param_index: -1 });
    await wait;
    return this.params.get(enc(name))!;
  }

  async set(name: string, value: number, opts: { retries?: number; timeoutMs?: number } = {}): Promise<SetResult> {
    if (this.conn.armed) throw new Error(`refusing to set ${name}: vehicle is armed`);
    const known = this.params.get(enc(name));
    if (!known) throw new Error(`unknown parameter ${name} (download params first)`);
    const retries = opts.retries ?? 3;
    let echoed: number | undefined;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const wait = this.conn.waitFor("PARAM_VALUE", (m) => m.fields.param_id === enc(name), opts.timeoutMs ?? 1000);
      await this.conn.send("PARAM_SET", { ...this.t, param_id: enc(name), param_value: value, param_type: known.type });
      try {
        echoed = (await wait).fields.param_value;
        if (sameParamValue(echoed, value)) return { name, requested: value, echoed, ok: true, attempts: attempt };
        // The vehicle answered with something else (e.g. clamped or rejected): don't retry blindly.
        return { name, requested: value, echoed, ok: false, attempts: attempt };
      } catch {
        // no answer; retry
      }
    }
    return { name, requested: value, echoed, ok: false, attempts: retries };
  }
}
