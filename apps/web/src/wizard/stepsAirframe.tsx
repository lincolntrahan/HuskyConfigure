import { useState } from "react";
import type { Profile } from "@husky/profile";
import huskyLua from "../../../../scripts/husky.lua?raw";
import { session, useSession } from "../state.ts";
import { StepShell, useLive } from "./common.tsx";
import type { Derived } from "./store.ts";

// ---------------- Companion script ----------------
export const BUNDLED_VERSION = Number(/local VERSION = (\d+)/.exec(huskyLua)?.[1] ?? 0);

export function ScriptStep({ d }: { p: Profile; d: Derived }) {
  const s = useSession();
  const live = useLive();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const running = live.hsk && Date.now() - live.hsk.t < 4000 ? live.hsk : undefined;
  const upToDate = running?.version === BUNDLED_VERSION;

  async function install() {
    setBusy(true); setMsg(undefined);
    try {
      const path = await session.uploadScript("husky.lua", huskyLua);
      if (d.board.get("SCR_ENABLE") !== 1) {
        const r = await session.write([{ name: "SCR_ENABLE", value: 1 }], "Enable scripting");
        if (!r.ok) throw new Error("couldn't enable scripting");
      }
      setMsg(`Uploaded to ${path}. Rebooting so it starts with its settings…`);
      await session.rebootAndReconnect("Rebooting to start the script");
      setMsg("Done. The script will report in within a few seconds. Then apply the Outputs, Failsafe and Arming steps: they have settings that only exist once the script runs.");
    } catch (e) {
      const m = (e as Error).message;
      setMsg(/errno 28|FailErrno/.test(m) ? "The board's SD card can't be written (full or missing). Replace or reformat the SD card (FAT32) and try again." : `Install failed: ${m}`);
    } finally { setBusy(false); }
  }

  return (
    <StepShell title="Companion script" d={d}
      intro={<p><code>husky.lua</code> runs on the flight controller. It holds the DBF failsafe pose when the link is lost, owns rudder-stick arming (so a missing or crashed script means the plane can't arm), and mixes surfaces ArduPilot can't (spoilerons).</p>}>
      {!d.facts.hasScripting ? (
        <p className="warn-box">This board's firmware has no Lua scripting (F4 boards). The failsafe uses ArduPilot's GLIDE, arming uses ArduPilot's own rudder arming, and scripted surfaces aren't available.</p>
      ) : (
        <>
          <p className={upToDate ? "ok-box" : "warn-box"}>
            {running ? `Running: version ${running.version}${upToDate ? " (current)" : `, but this tool has version ${BUNDLED_VERSION}`}.` : "Not running on the board."}
          </p>
          <button className="primary" disabled={busy || !session.canWrite || !!s.busy} onClick={() => void install()}>
            {running ? (upToDate ? "Reinstall" : `Update to version ${BUNDLED_VERSION}`) : "Install the companion script"}
          </button>
          {msg && <p className="muted">{msg}</p>}
          <p className="muted">Installing uploads the file to the SD card over USB, turns scripting on, and reboots the board (the tool reconnects by itself).</p>
        </>
      )}
    </StepShell>
  );
}
