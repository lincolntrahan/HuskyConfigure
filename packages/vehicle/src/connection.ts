import {
  FrameParser, decodeFrame, encodeFrame, MESSAGES, MSG_ID,
  type DecodedMessage, type MessageMap, type Payload,
} from "@husky/mavlink";
import type { Transport } from "./transport.ts";

type MsgName = keyof MessageMap;
type Listener = (m: DecodedMessage) => void;

export interface ConnectionOptions {
  /** Our system id. 255 is the conventional GCS id. */
  sysid?: number;
  /** Our component id. 190 = MAV_COMP_ID_MISSIONPLANNER, the conventional GCS component. */
  compid?: number;
  heartbeatMs?: number;
}

/**
 * One MAVLink link to one vehicle. Decodes everything, lets callers subscribe by message name,
 * sends our GCS heartbeat, and remembers which vehicle (sysid/compid) it's talking to.
 */
export class MavConnection {
  readonly sysid: number;
  readonly compid: number;
  target = { sysid: 0, compid: 0 };
  private seq = 0;
  private listeners = new Map<string, Set<Listener>>();
  private hbTimer?: ReturnType<typeof setInterval>;
  readonly parser: FrameParser;
  lastHeartbeat?: DecodedMessage<MessageMap["HEARTBEAT"]>;

  constructor(readonly transport: Transport, opt: ConnectionOptions = {}) {
    this.sysid = opt.sysid ?? 255;
    this.compid = opt.compid ?? 190;
    this.parser = new FrameParser(MESSAGES, (f) => {
      const m = decodeFrame(MESSAGES, f);
      if (!m) return;
      if (m.name === "HEARTBEAT" && m.compid === 1 && this.isVehicleHeartbeat(m)) {
        this.lastHeartbeat = m as unknown as DecodedMessage<MessageMap["HEARTBEAT"]>;
        if (!this.target.sysid) this.target = { sysid: m.sysid, compid: m.compid };
      }
      this.emit(m);
    });
    transport.onData((b) => this.parser.push(b));
    this.hbTimer = setInterval(() => void this.sendHeartbeat(), opt.heartbeatMs ?? 1000);
    void this.sendHeartbeat();
  }

  private isVehicleHeartbeat(m: { fields: { type?: unknown } }): boolean {
    // MAV_TYPE_GCS = 6; ignore other ground stations and companions.
    return (m.fields.type as number) !== 6;
  }

  private emit(m: DecodedMessage) {
    for (const key of [m.name, "*"]) this.listeners.get(key)?.forEach((cb) => cb(m));
  }

  on<K extends MsgName>(name: K | "*", cb: (m: DecodedMessage<MessageMap[K]>) => void): () => void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(cb as unknown as Listener);
    this.listeners.set(name, set);
    return () => set.delete(cb as unknown as Listener);
  }

  /** Resolve with the first message of this type matching `pred`, or reject after timeoutMs. */
  waitFor<K extends MsgName>(
    name: K, pred: (m: DecodedMessage<MessageMap[K]>) => boolean = () => true, timeoutMs = 2000,
  ): Promise<DecodedMessage<MessageMap[K]>> {
    return new Promise((resolve, reject) => {
      const off = this.on(name, (m) => {
        if (!pred(m)) return;
        clearTimeout(t); off(); resolve(m);
      });
      const t = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${name}`)); }, timeoutMs);
    });
  }

  async send<K extends MsgName>(name: K, fields: Partial<MessageMap[K]>): Promise<void> {
    const def = MESSAGES[MSG_ID[name]]!;
    const frame = encodeFrame(def, fields as Partial<Payload>, {
      sysid: this.sysid, compid: this.compid, seq: this.seq++ & 0xff,
    });
    await this.transport.write(frame);
  }

  private sendHeartbeat() {
    // type GCS, autopilot INVALID (8)
    return this.send("HEARTBEAT", { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4, mavlink_version: 3 })
      .catch(() => {});
  }

  /**
   * COMMAND_LONG with ack. Resolves with MAV_RESULT (0 = accepted). Retries on silence
   * (confirmation field incremented, per the command protocol), never on an explicit answer.
   */
  async command(command: number, p: number[] = [], opts: { timeoutMs?: number; retries?: number } = {}): Promise<number> {
    const retries = opts.retries ?? 3;
    for (let attempt = 0; attempt < retries; attempt++) {
      const wait = this.waitFor("COMMAND_ACK", (m) => m.fields.command === command && m.sysid === this.target.sysid,
        opts.timeoutMs ?? 1500);
      await this.send("COMMAND_LONG", {
        target_system: this.target.sysid, target_component: this.target.compid, command, confirmation: attempt,
        param1: p[0] ?? 0, param2: p[1] ?? 0, param3: p[2] ?? 0, param4: p[3] ?? 0,
        param5: p[4] ?? 0, param6: p[5] ?? 0, param7: p[6] ?? 0,
      });
      try { return (await wait).fields.result; } catch { /* retry */ }
    }
    throw new Error(`no COMMAND_ACK for command ${command}`);
  }

  /** MAV_CMD_SET_MESSAGE_INTERVAL for one message id. */
  setMessageRate(msgid: number, hz: number) {
    return this.command(511, [msgid, hz > 0 ? 1e6 / hz : -1]);
  }

  /** Wait until a vehicle heartbeat has been seen. */
  async ready(timeoutMs = 5000): Promise<void> {
    if (this.target.sysid) return;
    await this.waitFor("HEARTBEAT", (m) => m.compid === 1 && this.isVehicleHeartbeat(m), timeoutMs);
  }

  get armed(): boolean {
    // MAV_MODE_FLAG_SAFETY_ARMED = 128
    return ((this.lastHeartbeat?.fields.base_mode ?? 0) & 128) !== 0;
  }

  async close() {
    clearInterval(this.hbTimer);
    await this.transport.close();
  }
}
