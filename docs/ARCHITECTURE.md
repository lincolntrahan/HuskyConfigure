# HuskyConfigure — Architecture Draft

Status: draft v3 for team review, 2026-11-03. v3 adds general surface mixing (§5.9), a
team-editable policy instead of hard-coded rules (§2.1), and an arming gate that replaces
ArduPilot's nuisance pre-arm checks (§6.4).

A guided configurator for ArduPilot **Plane**, built for a DBF team that flies in MANUAL and
uses ArduPilot mostly for logging and telemetry. It runs as a website and as a Windows desktop
download. It must work fully offline, and its main job is to make a wrong configuration hard to
reach and impossible to miss.

---

## 1. Requirements we're designing against

| Area | What we know |
|---|---|
| Autopilots | **Competition:** H7 boards (Matek H743 Wing V3 today). **Trainers/test:** SpeedyBee F405 Wing is allowed, but without the scripted failsafe (§6). Next year's board may differ, so don't hard-code any of this. |
| Firmware | Always the **latest stable Plane** (4.7.2 as of Oct 2026). Upgrading must be one guided flow (§5.7). |
| Sensors | GPS, compass, airspeed sensor. Possibly an HX711 load cell read by a team Lua script later. The tool needs a script manager, but the HX711 itself is out of scope for now. |
| RC | ExpressLRS. Both CRSF mode and MAVLink mode must work, on whichever UART it's wired to, and the tool should **detect** which (§5.8). |
| Telemetry | Setup is over **USB**. MAVLink over ELRS is a later feature, so the design leaves room for it but doesn't depend on it. SD-card logging starts at arm. |
| ESC | Hargrave MicroDrive LP on DShot today. Must support PWM, every DShot rate, bidirectional DShot and serial-wire ESC telemetry. |
| Airframes | Anything, including **mixed surfaces**: one surface can take several inputs (e.g. aileron + spoiler = spoileron, aileron + flap = flaperon, elevator + rudder = ruddervator), plus steering, payload/banner mechanisms and raw RC passthrough. |
| Flight modes | **MANUAL, FBWA, ACRO** by default. The allowed list is team policy, not code. |
| RC-loss failsafe | DBF pose: **throttle closed, full up elevator, full right rudder, full right aileron, full flaps down, spoilers stowed**, starting **1 s** after link loss. Control returns to the pilot when the link comes back. |
| Arming | Rudder stick. ArduPilot's nuisance pre-arm checks are off; one small arming gate the team controls takes their place (§6.4). |
| Users | A few members, not necessarily well trained. Full setup at build time, short checks at the field. |
| Platforms | Web (Chrome/Edge) and **Windows** desktop. macOS dropped. Fully offline. |
| Profiles | Live in the team git repo. |
| UX rule | The common path is simple. Everything else sits behind an **Advanced** disclosure in each step, closed by default. |
| Flexibility | The tool must not box the team in. Its opinions are defaults the team can change, and nothing it doesn't model is out of reach. |

## 2. Core idea: configure the *airplane*, not the parameters

Mission Planner asks you to edit ~1,000 parameters. We don't. The user describes the airplane:
what surfaces it has, which pad each servo is plugged into, which UART the receiver is on, what
the ESC is. A **compiler** turns that description into the exact parameter set (plus generated
script settings), and a **rules engine** refuses to produce a configuration that breaks a safety rule.

```
 Aircraft Profile (JSON in the team git repo)
        │
        ▼
 Profile Compiler ──► Desired params + failsafe script config ──► Rules engine (errors / warnings)
        │                                                                │
        ▼                                                                ▼
 Diff against live vehicle ──► Plain-English review ──► Write + verify + reboot + re-verify
        │
        ▼
 Physical checks (human confirms with pictures; tool confirms with live telemetry)
```

Why this matters for safety:

- **Deterministic.** The same profile always produces the same parameters, so it can be unit-tested.
- **Reviewable.** A profile is ~100 lines a teammate can review in a PR. A `.param` dump is not.
- **Repeatable at the field.** The field check compiles the stored profile and diffs it against the plane. Any drift shows up red.
- **Survives firmware upgrades.** The profile says "skip every check except the arming gate". The compiler knows that means different bits in `ARMING_CHECK` (4.6) and `ARMING_SKIPCHK` (4.7).
- **Scoped.** The wizard only touches parameters it *owns* (listed per step). Everything else on the vehicle is left alone and preserved.

### 2.1 Flexible, not prescriptive

Guard rails are only useful if they don't get in the way, so the tool's opinions live in data
the team owns rather than in code.

- **Team policy file** (`policy.json` in the team repo). It holds the allowed flight modes, the failsafe pose, which arming checks run, logging presets, the field checklist, and the **severity of every rule** (error / warning / off). Changing team practice is a reviewed PR to that file, not a code change.
- **Per-aircraft overrides with a reason.** A profile can relax any policy rule for one aircraft by writing down why. The override is shown in the review screen and printed on every field-check report, so it's a visible decision rather than a silent one.
- **A small fixed core.** Only rules that describe something that *physically cannot work* are not overridable: two functions on one output, DShot and PWM in the same timer group, `min > max`, a setting the firmware doesn't have.
- **Wizard *and* editor.** The wizard is for first setup. After that every section of the profile is directly editable on one page, in any order. The verification ledger (§5.6) says which physical checks a change makes stale, instead of forcing a walk back through the wizard.
- **Nothing is out of reach.** The Advanced raw-parameter editor covers anything the profile doesn't model. Any raw parameter can also be **pinned** in the profile (`advanced.params`), so it's written, diffed and checked at the field like everything else.
- **General mixing** (§5.9) and **team scripts** (e.g. the HX711) are first-class parts of a profile, not special cases.

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One codebase for web and desktop, strong typing for parameter/profile schemas. |
| UI | React + Vite | The wizard is mostly forms, live gauges and diagrams. |
| Schema/validation | Zod | Profile schema, compiler input and rule definitions in one place. |
| Web transport | **Web Serial API** | USB to the flight controller from Chrome/Edge. Other browsers get a "use Chrome or the desktop app" screen. |
| Desktop shell | **Electron (Windows)** | It ships Chromium, so the *same* Web Serial code runs in both. Electron also lets us **pick the serial port programmatically**: the browser makes the user re-pick the port after every reboot, and after the flight controller drops into its bootloader for a firmware flash. Electron also gives UDP/TCP for the later ELRS-WiFi telemetry work. Tauri was considered, but its Windows WebView doesn't give us that port control. |
| Offline (web) | PWA with a service worker | Code, parameter metadata, board data, bundled Lua scripts and cached firmware are all available offline after the first visit. |
| MAVLink | Generated TS codec from the ArduPilot dialect XML | We need ~35 messages plus MAVLink FTP. In Phase 0 we test it against pymavlink-encoded test vectors, and we'll use an existing browser-safe library instead if one passes. |
| Tests | Vitest (unit), Playwright (UI), **ArduPilot SITL** (integration) | SITL (software-in-the-loop) runs real Plane firmware on a PC. CI runs every wizard step and the failsafe script against it. |
| Hosting | GitHub Pages (static) | No backend needed. |

## 4. Repository layout (monorepo, npm workspaces)

```
packages/
  mavlink/      codec, framing, MAVLink FTP, transports (WebSerial, Electron serial/UDP, WebSocket for SITL)
  vehicle/      connection manager, param manager, command/ack manager, calibration services,
                live telemetry store, armed-state guard, script manager, firmware flasher
  metadata/     generated per-firmware parameter metadata + board database (read-only data)
  profile/      profile schema, compiler, rules engine, airframe templates, failsafe-pose solver
  wizard/       step engine: step definitions, dependency graph, verification ledger
  scripts/      Lua scripts we ship (husky.lua: mixer, failsafe, arming gate), with their own SITL tests
apps/
  web/          React UI, PWA
  desktop/      Electron main process (serial port control, UDP, file dialogs)
tools/
  gen-metadata/ builds metadata from ArduPilot source at each supported release tag
  gen-boards/   builds board DB from ArduPilot hwdef files
test/
  sitl/         scripted end-to-end runs against SITL Plane
docs/
```

## 5. Key subsystems

### 5.1 Metadata: knowing what parameters mean, per firmware version

Parameter names and meanings change between releases. Last year's files are 4.5/4.6-era
(`ARMING_CHECK`, `SRn_*` stream rates). 4.7 renames or moves several of these:
pre-arm control becomes `ARMING_SKIPCHK`, stream rates move to `MAVn_*`, and some
`SERIALn_OPTIONS` bits move to `MAVn_OPTIONS`. The `apm.pdef.json` on the autotest server
tracks *master*, not the release you're flying.

- `tools/gen-metadata` checks out each release tag, runs ArduPilot's own parameter-doc generator, and emits `metadata/plane-4.7.x.json`. These are bundled in the app, so it works offline.
- On connect, read `AUTOPILOT_VERSION`. **Firmware the tool doesn't know → read-only mode**, plus an offer to upgrade to a supported release.
- A small **version adapter** maps the compiler's logical settings onto that version's real parameter names.
- Metadata supplies ranges, enums, bitmask names and `RebootRequired` flags. Every value the user can type is range-checked against it.

### 5.2 Board database: knowing the hardware

From each board's `hwdef.dat` at the same release tags, `tools/gen-boards` extracts:

- **Serial map.** For the Matek H743 the order is `USB, UART7, UART1, UART2, UART3, UART8, UART4, UART6`. So the pad labelled `TX1/RX1` is **SERIAL2**, `TX3/RX3` is SERIAL4, `RX4` is SERIAL6, and `TX6/RX6` is SERIAL7. Nobody should have to know that, which is why the tool shows pad labels, not SERIAL numbers.
- **Output timer groups.** On the H743: S1–S2 share TIM8, S3–S6 TIM5, S7–S10 TIM4, S11–S12 TIM15, S13 TIM1. The motor on S1 running DShot means S2 must be DShot or unused. Last year's wiring respects this, but nothing stopped someone plugging a servo into S2.
- **Firmware targets.** Some boards have a separate `-bdshot` firmware build for bidirectional DShot. The standard MatekH743 hwdef has no bidirectional tags. So if the profile asks for bidirectional DShot, the firmware manager must flash the right target. That's worth checking: last year's params set `SERVO_BLH_BDMASK=1`, which does nothing on the standard target.
- **Features compiled in:** scripting, Advanced Failsafe, etc. The SpeedyBee F405 Wing stable build has **no scripting and no Advanced Failsafe**.
- **Default battery/airspeed pins and scales**, and a **pinout image** (hand-made for boards we own; generic otherwise).

The board is identified on connect. An unknown board falls back to "generic mode", where
everything still works but with louder warnings and no pad labels.

### 5.3 Vehicle layer

- **Param manager:** full download with gap-fill retries. Writes use `PARAM_SET`, each confirmed by the echoed `PARAM_VALUE`, with retries. Floating-point comparison is type-aware.
- **Command manager:** `COMMAND_LONG` with `COMMAND_ACK` tracking and timeouts.
- **Calibration services:** accel 6-position and level, compass, airspeed zero, gyro.
- **Script manager:** uploads bundled scripts to `APM/scripts` over MAVLink FTP and reads them back to verify. It also pins `SCR_LD_CHECKSUM` / `SCR_RUN_CHECKSUM`, so ArduPilot itself refuses to arm if the expected script is missing, edited or not running. The future HX711 script goes through the same path.
- **Firmware flasher:** ArduPilot bootloader protocol over serial (§5.7).
- **Telemetry store:** `HEARTBEAT`, `SYS_STATUS`, `ATTITUDE`, `RC_CHANNELS`, `SERVO_OUTPUT_RAW`, `GPS_RAW_INT`, `VFR_HUD`, `ESC_TELEMETRY_*`, `BATTERY_STATUS`, `NAMED_VALUE_FLOAT` (script heartbeat), `STATUSTEXT` (arming-gate and pre-arm messages).
- **Armed-state guard:** if `HEARTBEAT` reports armed, every write, calibration, script upload and flash is blocked immediately, including one already in progress.
- **Board identity:** the flight controller's unique ID is recorded in the profile. Loading a profile onto a *different* flight controller is allowed, but it forces orientation, accel cal and every physical check to be redone.

### 5.4 Profile

One JSON file per aircraft in the team repo, e.g. `profiles/mako-v2-sn1.json`:

```jsonc
{
  "schema": 1,
  "name": "Mako V2 SN-1",
  "board": { "type": "MatekH743", "uid": "…" },
  "firmware": "4.7",
  "orientation": "YAW_270",
  "receiver": { "type": "elrs", "mode": "crsf", "pads": "TX1/RX1" },
  "gps": { "pads": "TX3/RX3" },
  "compass": { "use": false },
  "airspeed": { "type": "analog", "pin": 4 },
  "modes": { "channel": 8, "slots": ["MANUAL", "FBWA", "MANUAL", "MANUAL", "ACRO", "MANUAL"] },
  "arming": { "method": "rudder", "rudderDisarm": false },
  "motors": [{ "output": "S1", "protocol": "DSHOT300", "bidir": false,
               "telemetry": { "source": "wire", "pads": "RX4" }, "poles": 14 }],
  "inputs": {
    "spoiler": { "rcIn": 7 }                       // team-defined input, a switch or slider
  },
  "surfaces": [
    { "name": "Right ruddervator", "output": "S3", "side": "right",
      "mix": [{ "in": "pitch", "w": 1.0 }, { "in": "yaw", "w": -1.0 }],
      "reversed": false, "trim": 1450, "min": 1000, "max": 1890 },
    { "name": "Left ruddervator",  "output": "S4", "side": "left",
      "mix": [{ "in": "pitch", "w": 1.0 }, { "in": "yaw", "w": 1.0 }] },
    { "name": "Tailwheel",         "output": "S5", "mix": [{ "in": "yaw", "w": 1.0 }] },
    { "name": "Left spoileron",    "output": "S6", "side": "left",
      "mix": [{ "in": "roll", "w": 1.0 }, { "in": "spoiler", "w": 0.6 }] },
    { "name": "Right spoileron",   "output": "S8", "side": "right",
      "mix": [{ "in": "roll", "w": -1.0 }, { "in": "spoiler", "w": 0.6 }] },
    { "name": "Banner deploy",     "output": "S11", "mix": [{ "in": "rc15" }] },
    { "name": "Banner release",    "output": "S12", "mix": [{ "in": "rc14" }] }
  ],
  "failsafe": {
    "method": "lua-pose",
    "delayMs": 1000,
    "pose": { "spoiler": "stowed", "rc14": "hold", "rc15": "hold" }   // DBF axes come from policy
  },
  "battery": { "monitors": ["esc-telemetry", "board-analog"], "cells": 2 },
  "logging": { "backend": "sd", "whenDisarmed": false, "preset": "dbf-standard" },
  "scripts": [],
  "advanced": { "params": {} }
}
```

- **A surface is a physical thing with a mix**, not an ArduPilot function number. It has a name, a side, an output pad, and a list of weighted inputs (`roll`, `pitch`, `yaw`, `throttle`, `flap`, any team-defined input, or any raw RC channel). The compiler picks the implementation (§5.9). This catches the kind of mix-up visible in last year's files (§9).
- **Templates** (conventional, V-tail, elevon, flaperon, spoileron, …) just pre-fill `surfaces`. Every mix stays editable.
- `advanced.params` is the escape hatch for anything the schema doesn't model. Those values are still range-checked, and they're highlighted in the review.

### 5.5 Rules engine

Rules are small pure functions over (profile, compiled params, board, metadata). Each one
returns **error** (blocks writing), **warning** (must be acknowledged by name), or **info**.
The severities below are the **shipped defaults in `policy.json`**. The team can change them,
and a profile can override them with a reason (§2.1). Only the "physically can't work" core is fixed.

Default errors
- **Any flight mode other than MANUAL/FBWA/ACRO reachable by any route:** `FLTMODE1–6`, any `RCx_OPTION` that selects a mode, `INITIAL_MODE`, or the GCS. `FLTMODE_GCSBLOCK` is set so Mission Planner can't switch the plane into anything else either.
- Failsafe pose required (competition profile) but the board can't run scripting.
- Native RC failsafe off (`THR_FAILSAFE=0`), or any failsafe action other than GLIDE.
- Arming gate (§6.4) disabled on a scripting-capable board.
- No throttle output; a DShot output sharing a timer group with a PWM output; two functions on one output; a required surface with no output.
- `min < trim < max` violated, or a range outside metadata bounds.
- Receiver UART lacks DMA on an F4/F7 board; more than one RC input port.
- Compass enabled but not calibrated (the EKF needs it even with the pre-arm check off).
- Orientation not verified, or accel cal older than the last orientation change or board swap.
- A step's verification is stale (§5.6).

Warnings
- Trim outside 1450–1550 µs ("fix the linkage instead": straight from the ArduPilot guide).
- Rudder *disarm* enabled (ArduPilot warns it can disarm in flight if the plane misjudges whether it's flying).
- ESC telemetry configured but `SERVO_BLH_POLES` doesn't match the motor (RPM will read wrong; last year's was 1).
- Bidirectional DShot requested on a firmware target that doesn't support it.
- Anything in `advanced.params`.

### 5.6 Wizard engine

Each step is declared, not hand-wired:

```ts
defineStep({
  id: "surface-directions",
  title: "Control surface directions",
  requires: ["outputs", "rc-mapping"],
  appliesWhen: (p) => p.surfaces.length > 0,
  ownsParams: (p) => p.surfaces.map(s => `SERVO${outNum(s.output)}_REVERSED`),
  checks: ["manual-direction"],
  component: SurfaceDirectionsStep,
});
```

The engine keeps a **verification ledger.** Each passed physical check records a hash of the
parameters (and firmware version and board UID) it depends on. If any of those change later,
the check flips back to "not verified" and the step goes yellow. For example, flipping
`SERVO3_REVERSED` invalidates the MANUAL direction check, the FBWA/ACRO check *and* the failsafe
pose check. A firmware upgrade invalidates everything physical. You cannot get to "Done" with a
stale check.

### 5.7 Firmware manager

1. **Pick the target.** Board plus options, e.g. `MatekH743` vs `MatekH743-bdshot` if bidirectional DShot is wanted.
2. **Get the firmware.** Online: the latest stable from firmware.ardupilot.org's manifest, then cached. Offline: whatever is cached, with its version shown. Electron fetches directly; for the website, CORS on that server needs checking in Phase 0, with a fallback of manually loading a downloaded `.apj`.
3. **Back up** all params, plus the profile hash.
4. **Flash** via the ArduPilot bootloader protocol (reboot to bootloader, erase, program, verify CRC). Electron re-opens the bootloader port automatically. The website asks the user to pick it once.
5. **Re-sync.** ArduPilot migrates most renamed params itself on first boot. The tool then compiles the profile for the *new* version, diffs, writes the differences, re-uploads scripts if needed, and re-verifies.
6. Every physical check goes stale, so the field check (or the relevant wizard steps) must be re-run before flying.

### 5.9 Mixer: any input on any surface

Each surface's `mix` is a list of `{input, weight, curve}` terms. Curves are linear, or
one-sided (only up / only down) for things like upper-surface spoilers. The output is the
clamped sum. The compiler then picks the **least fragile implementation** for each surface:

1. **Native ArduPilot function** when the mix matches one exactly: aileron, elevator, rudder, flap, flaperon (24/25), elevon (77/78), V-tail (79/80), differential spoilers, ground steering, RC passthrough. These keep working even if scripting stops, and they're what the F405 gets.
2. **Scripted surface** when no native function matches, e.g. a spoileron (aileron + spoiler on one surface, or a one-sided curve). The output is set to a scripting function (`Script n`), and the Husky script computes it every loop from ArduPilot's own logical aileron/elevator/rudder/flap/throttle outputs. Those already include FBWA/ACRO stabilization, so mixed surfaces still behave correctly in every mode.

The review screen labels each surface **native** or **scripted**. A scripted surface depends
on the script running, which the arming gate (§6.4) guarantees before takeoff. If the script
stops in flight, the watchdog behavior is defined in §6 and tested in SITL.

The same mixer math runs in TypeScript inside the tool. That's what lets the tool predict every
output's PWM for the direction checks and the failsafe pose. A SITL test checks that the TS mixer
and the Lua mixer agree output-for-output on randomized inputs, so the two can't drift apart.

### 5.8 Receiver detection

The user clicks the pads the receiver is wired to on the board picture, or picks "I don't know".
The tool then:

1. Reads the current `SERIALn_PROTOCOL` values and checks whether RC is already arriving (`RC_CHANNELS`) or an ELRS MAVLink stream is present.
2. If nothing works, probes the chosen pad (or each free UART when the user doesn't know): set it to RC input (CRSF), reboot, look for RC; then set it to MAVLink2, reboot, look for RC from the receiver. One reboot per attempt.
3. Writes the configuration that worked, and clears stale RC/MAVLink settings on other ports. Last year's SERIAL7 RC-input setting was probably one of these.

In Phase 0 we confirm which signals reliably identify ELRS MAVLink mode, and the documented
quirk that an ELRS receiver can stay disconnected after a MAVLink-commanded reboot until it's
power-cycled. The wizard has to prompt for that.

## 6. RC-loss failsafe design

**Why not ArduPilot's built-in Advanced Failsafe (AFS)?** Its termination does exactly the DBF
pose: flaps 100%, aileron/rudder/elevator to max, throttle min. But AFS stays in its pre-flight
state until the plane has been in **AUTO** at least once, so on a MANUAL-only plane its RC-loss
termination never activates. It also latches until reboot, and it has other termination triggers
(dual loss, baro, range). That matches why the team needed a Lua script before. AFS is not used,
and the tool forces `AFS_ENABLE=0`.

**Two layers:**

| Layer | Boards | What it does |
|---|---|---|
| Native RC failsafe (always on) | All | `THR_FAILSAFE=1`, `FS_SHORT_ACTN` / `FS_LONG_ACTN` = GLIDE (FBWA with throttle cut), sensible `RC_FS_TIMEOUT`. This is the whole failsafe on F405 boards, and the fallback on H7 if the script is ever not running. |
| `husky.lua` (competition) | H7 / scripting-capable | Holds the DBF pose while RC is lost, and releases it the moment RC is valid again. In the wizard this option is greyed out on boards without scripting, with the reason shown. |

**`husky.lua`: one script, three jobs.** It never changes per aircraft. Its settings live in
its own parameter table (prefix `HSK_`), which the tool writes from the profile, so nobody
types PWM values.

1. **Mixer** for scripted surfaces (§5.9).
2. **Failsafe pose.** The pose is defined on the *inputs* (roll full right, pitch full up, yaw full right, flap full down, throttle closed, spoiler stowed, other team inputs per profile). The **tool** runs it through its TypeScript mixer and writes one PWM per output (`HSK_FS_PWM1…16`). When ArduPilot declares the RC link invalid (after `RC_FS_TIMEOUT`, set to **1 s**) plus an optional extra `HSK_FS_DLY` (default 0), the script holds each listed output at its PWM with a short timeout (`SRV_Channels:set_output_pwm_chan_timeout`, ~200 ms). Because the pose is applied to inputs, **any mix gets the right pose automatically**: spoilerons go to full right roll with spoilers stowed, ruddervators get the saturated up+right result, and so on. The script itself stays dumb, so there's less in Lua to go wrong.
3. **Arming gate** (§6.4).

When RC returns, the script stops re-commanding, the timeout runs out, and the pilot has
control. If the script dies, native surfaces fall back to ArduPilot's GLIDE failsafe within
~200 ms. Scripted surfaces stop being updated. ArduPilot's behavior for an orphaned scripting
output is a Phase 0 item, and the result decides whether a policy rule should limit which
surfaces may be scripted (e.g. spoilerons yes, elevator no). The script sends a heartbeat
(`NAMED_VALUE_FLOAT`) so the tool and field check can see it's alive.

**Pose preview.** The tool runs the same pose through its TypeScript mixer and shows each
surface's resulting position on a diagram, including where a mix saturates. Inputs outside the
DBF list (banner mechanisms, other passthrough) get an explicit choice: **hold / trim / min / max**.

**Verification:** "Turn the transmitter OFF." The tool compares every output in
`SERVO_OUTPUT_RAW` to the expected PWMs, then asks the user to confirm each surface against a
picture of the pose. Then "Turn it back ON" and the tool checks that control returns. This is the
same test as the startup-checklist inspection item, so the field check runs it too.

**Verified in SITL (Plane 4.7.2, see `docs/PHASE0.md`):** pose reached 1.02 s after the RC cut;
the native layer switches to GLIDE (FBWA, throttle 0) at the same moment; pose released ~0.3 s
after RC returns; stopping the script mid-failsafe hands the outputs to GLIDE within ~0.22 s.
**Still to verify on hardware:** override of a DShot throttle output; the RC-valid signal with
CRSF vs MAVLink-mode ELRS; what an orphaned *scripted* surface does if the script stops; loop
timing and latency on scripted surfaces.

**Script parameter layout is append-only.** ArduPilot stores script parameters by table slot, not
name. Inserting a parameter mid-table during Phase 0 moved saved failsafe values into the wrong
slots. New script parameters always go at the end, and the tool rewrites every `HSK_` value
whenever it installs a new script version.

### 6.4 Arming gate instead of nuisance pre-arm checks

ArduPilot's pre-arm checks fire for lots of reasons that don't matter to a MANUAL-flown DBF
plane, and last year they were simply all turned off. But "all off" also removes the only thing
that would stop a takeoff with the failsafe script missing. The design keeps one narrow gate:

- **Every ArduPilot check category is skipped by default** except *auxiliary authorisation* (`ARMING_SKIPCHK` in 4.7; the exact bits come from the metadata). ArduPilot's few mandatory checks still apply, such as refusing to arm while in RC failsafe.
- **Auxiliary authorisation is a hook that a Lua script answers.** `husky.lua` registers as an authoriser and refuses with a reason while any gate item fails.
- **Rudder-stick arming is done by the script, not ArduPilot** (`ARMING_RUDDER=0`, `HSK_RUD_ARM=1`). The pilot does the same thing as before: hold right rudder with throttle low for 2 s. SITL showed why this matters. ArduPilot **remembers an authoriser's last "pass" after the script stops**, so a script that died while passing still let the plane arm. A script that never loaded (no SD card) never registers at all, and ArduPilot's script-checksum check didn't block arming in that state either. With the script owning the stick arming, **no running script means no stick arming**. Remaining gap: arming from a GCS button bypasses this. The team doesn't arm that way, and the field check flags it.
- **The script decides what blocks arming,** from a short list set in `policy.json`. The defaults are only things that matter: RC link valid, script config matches what the tool wrote (a hash the tool stores), SD card logging ready, IMU healthy. Each refusal is one clear message ("Can't arm: SD card not logging").
- **The team can tune it either way.** Individual ArduPilot checks (GPS fix, compass, airspeed, battery…) can be switched back on per profile, each with a plain-English description and the policy default shown. Items in the gate can be added, removed, or set to "warn only". Every choice is printed on the field report.
- **F405 boards** have no scripting, so there's no gate: all checks off, with a warning shown in the review and on every report.

Verified in SITL: `ARMING_SKIPCHK = 655358` skips every 4.7.2 category except AuxAuth (bit 17).
With it set, the gate refused when blocked and when the config had been hand-edited, and allowed
arming with a good config. Script rudder arming armed on a 2 s hold, ignored a 1 s hold and a
hold with throttle up, and did nothing with the script stopped.

## 7. Safety mechanisms (the "idiot-proof" list)

1. **Automatic backup** of every parameter, with a timestamp, before the first write of any session and before any firmware flash. One-click restore.
2. **Nothing is written without a review screen.** The review shows a plain-English diff ("Right aileron will be reversed") with raw parameter names under a disclosure.
3. **Verified writes.** Every value is read back. After a reboot the whole set is re-downloaded and diffed again. If anything doesn't match, the screen goes red and offers to restore.
4. **Armed = locked.** No writes, calibrations, uploads or flashes while armed.
5. **Props-off gate.** Any step that powers the servo rail or can spin the motor requires a checkbox: "Propeller is removed". It is re-asked on each new connection. USB alone usually doesn't power the servo rail, so surface checks need the avionics battery connected.
6. **Human checks are explicit and pictured.** "Push the roll stick RIGHT. Which way did the RIGHT aileron move?" Up/Down buttons with a diagram, and no default answer. A wrong answer leads to the fix, then a re-test.
7. **Machine checks back up human checks.** The tool watches `RC_CHANNELS`, `SERVO_OUTPUT_RAW` and `ATTITUDE` to confirm the user actually did what it asked before accepting an answer.
8. **Only three modes exist.** MANUAL/FBWA/ACRO is enforced on the switch, aux functions, initial mode, failsafe actions and GCS mode commands.
9. **Owned parameters only.** The wizard can't accidentally change something it doesn't model.
10. **Firmware gate.** Unknown firmware means read-only.
11. **Advanced is hidden, not unguarded.** Advanced panels and the raw parameter editor still go through metadata validation and the rules engine.
12. **Field check produces a record.** A saved report with date, aircraft, profile hash, firmware, every check result and who ran it.

## 8. Workflows

### 8.1 Start screen

`Connect (USB)` → identify board, firmware, vehicle type (must be Plane) and board UID →
automatic backup → choose one:

- **Set up a new aircraft** (full wizard)
- **Load an aircraft profile** (from the repo onto a new or replacement board, then the physical checks)
- **Field check**
- **Update firmware**
- **Advanced** (raw parameters, scripts, logs, MAVLink inspector)

### 8.2 Full setup wizard

Order matters: each step relies on the ones before it. Checkpoint writes happen where a step
needs live parameters (marked ✎). Each gets a mini-review, and step 23 is the final
whole-profile review.

| # | Step | What the user does | What the tool does / sets |
|---|---|---|---|
| 1 | **Firmware** | Nothing if already on the latest stable; otherwise one click. | §5.7. Picks the `-bdshot` target later if step 13 asks for it. |
| 2 | **Board & mounting** | Confirm the board from a picture. | Board DB lookup; records the board UID. |
| 3 | **Orientation** ✎ | Put the plane level, then lift the nose. | Works out `AHRS_ORIENTATION` from the gravity vector in two poses, shows it on a 3D model, confirms "roll right → model rolls right". (Last year's two boards used two different orientations.) |
| 4 | **Accelerometer** | Six pictured positions with a "hold still" meter, then level in flying attitude. | Drives the calibration; shows success/failure. |
| 5 | **Receiver** ✎ | Click the pads it's wired to (or "don't know"). | §5.8 detection. Sets the `SERIALn_*`, `RSSI_TYPE` and `RC_OPTIONS` ELRS baud bit; proves RC arrives with live bars. |
| 6 | **Stick mapping** ✎ | "Move ONLY the roll stick RIGHT", then pitch, throttle, yaw. | Detects which channel moved and which way, then sets `RCMAP_*` and `RCn_REVERSED`. |
| 7 | **Stick ranges** ✎ | All sticks/switches to their ends; center sticks, throttle low. Then engage **throttle cut**. | `RCn_MIN/MAX/TRIM`. Checks that normal low throttle sits above `THR_FS_VALUE` and that throttle cut lands at min. |
| 8 | **Switches** ✎ | Flip the mode switch through each position. | `FLTMODE_CH`, `FLTMODE1–6` from MANUAL/FBWA/ACRO only; `FLTMODE_GCSBLOCK`; clears mode-selecting aux options. |
| 9 | **Arming** | Confirm rudder arming. | `ARMING_REQUIRE=1`, `ARMING_RUDDER=1` (arm only; disarm-by-rudder is under Advanced with a warning). Arming-gate items and any ArduPilot checks to keep on, each with a plain-English description (§6.4). |
| 10 | **GPS** ✎ | Click its pads. | `SERIALn_PROTOCOL=5`, `GPS1_TYPE`; shows satellites and fix. |
| 11 | **Compass** | Choose "use it" (guided calibration) or "don't use it". | Either a completed cal, or `COMPASS_USE*=0` cleanly. Planes fly fine on GPS heading; the choice is explicit either way. |
| 12 | **Airspeed** ✎ | Pick the sensor; cover the pitot and zero; then blow gently into it. | `ARSPD_TYPE/PIN/…`; confirms the reading rises with the right tube order. |
| 13 | **Airframe** | Pick a template; add flaps/spoilers/steering/passthrough. | Builds `surfaces` with physical roles. |
| 14 | **Outputs** ✎ | Click which pad each servo/ESC is plugged into. | `SERVOn_FUNCTION`; timer-group rules checked live. |
| 15 | **Motor & ESC** ✎ | PWM/DShot rate, bidirectional or not, telemetry source (bidir / wire to pad X / none), motor pole count. Props-off gate. | `SERVO_BLH_*`, `SERVO_DSHOT_ESC`, `SERIALn_PROTOCOL=16`, `BATTn_MONITOR=9`. PWM ESCs get a guided calibration. Shows live RPM/temp if present. |
| 16 | **Surface directions (MANUAL)** ✎ | Per surface: move the stick, answer which way it moved. | `SERVOn_REVERSED`, confirmed against `SERVO_OUTPUT_RAW`. |
| 17 | **Trim & throws** ✎ | Per surface: drag a slider to center, then to each end without buzzing or binding. | `SERVOn_TRIM/MIN/MAX`, sent live while dragging. |
| 18 | **Stabilization check (FBWA + ACRO)** | The tool puts the plane in FBWA (disarmed): "Tilt the plane right — did the right aileron go DOWN?", and the same for nose up. Then ACRO: "Rotate the plane — the surfaces should push against the motion." | This is the check that protects you if someone hits the mode switch, and it's also what GLIDE relies on. Confirms the tilt from `ATTITUDE`; handles the `KFF_RDDRMIX` rudder caveat; returns to MANUAL. |
| 19 | **Failsafe** ✎ | Review the computed pose on a diagram; choose hold/trim/min/max for non-DBF outputs. Then TX off, confirm, TX on. | §6. Uploads the script, sets `HSK_*` and the config hash, native GLIDE. On F405: GLIDE only, with the pose option greyed out. |
| 20 | **Battery** ✎ | Cell count; optional "type the voltage your multimeter reads". | `BATTn_*` from board defaults and ESC telemetry, voltage calibration, low/critical thresholds (warn only by default). |
| 21 | **Telemetry & MAVLink** | Usually nothing. | MAVLink2 on USB; sensible stream rates. ELRS MAVLink rates are a later feature, behind Advanced. |
| 22 | **Logging** | Nothing by default. | `LOG_BACKEND_TYPE=1`, `LOG_DISARMED=0`, team `LOG_BITMASK` preset; checks the SD card is present. |
| 23 | **Review & write** | Read the plain-English diff and confirm. | Write → verify → reboot → re-download → diff. |
| 24 | **Final verification** | Quick re-run of steps 16, 18 and 19; see the arming gate report ready. | Saves the profile (ready to commit), a `.param` snapshot and a setup report. |

### 8.3 Field check (mirrors the Avionics Start / Pre-Arm checklists; target under 3 min)

| Checklist item | What the tool does |
|---|---|
| A/C on a level surface, airspeed covered, AV power on | Waits for connection; warns if the airspeed reading at boot suggests the pitot wasn't covered. |
| Wait for positive control | Live `RC_CHANNELS` and link quality. |
| Connect / MAVLink uplink good | Heartbeat and a command round-trip. |
| *(new)* Configuration matches | Compiles the profile and diffs it against the plane: firmware, board UID, params, script version and config hash. Green, or red with what drifted. |
| Controls free + correct | Quick wiggle in MANUAL, then a quick FBWA tilt. |
| *(new)* Failsafe pose | TX off → outputs match the computed pose → TX on → control returns. |
| GPS 3D fix | `GPS_RAW_INT` fix type and satellites. |
| Batt health, throttle cut enabled | Voltage plausible; throttle at min with cut on. |
| Arming gate | Script alive; gate reports ready, or lists exactly what blocks arming. |

The rest of the team checklist (prop nut, linkages, hatches, banner path…) is shown as a sign-off
list, loaded from a file in the team repo so the team edits it there. The finished report is
saved with the flight log.

## 9. What last year's files showed

These are taken only as examples, not as this year's design. They show the kinds of mistakes
the tool is built to catch:

| Finding | Where | Tool response |
|---|---|---|
| All pre-arm checks off (`ARMING_CHECK=0`), so nothing would stop a takeoff with the failsafe script missing | all three param files | Nuisance checks stay off, but the arming gate (§6.4) refuses to arm without the script. |
| Native RC failsafe off (`THR_FAILSAFE=0`, FS actions 0) | all three | Hard error; GLIDE always on underneath the script. |
| Mode switch slots included **FBWB** and **AUTO**. One board also had a 6-item mission loaded, so a bumped switch could have started it. | `FLTMODE2=6`, `FLTMODE6=10`, `MIS_TOTAL=6` | Only MANUAL/FBWA/ACRO allowed anywhere. |
| Wiring sheet says S6 = left aileron and S8 = right aileron. The SN-1 params put the *right* flaperon function on S6 and the *left* on S8. Roll can be "fixed" with reversal, but any flap mixing then goes the wrong way. | sheet vs `SERVO6/8_FUNCTION` | Roles are physical; the direction checks test roll *and* flap separately. |
| Sheet puts the receiver on UART1 (SERIAL2 = MAVLink2), but SERIAL7 (UART6) was also set to RC input. | sheet vs `SERIAL2/7_PROTOCOL` | Detection, and stale ports cleared. |
| Bidirectional DShot enabled on a firmware target that likely doesn't support it, and `SERVO_BLH_POLES=1` | `SERVO_BLH_BDMASK=1` | Firmware target selection; pole-count warning. |
| Rudder **disarm** enabled (`ARMING_RUDDER=2`) | all three | Default arm-only; disarm is under Advanced with a warning. |
| Two "identical" V2 boards with different orientation and output maps | 02_13_26 vs SN-1 | Profiles bound to a board UID. |

## 10. Testing strategy

- **Unit tests:** compiler (profile → params golden files), every rule, the version adapter, the failsafe-pose solver (every airframe template × reversal combinations), and the MAVLink codec against pymavlink vectors.
- **SITL integration (CI):** Plane SITL for each supported release. Scripts drive the wizard with simulated RC and verify the resulting params, mode behavior, and the **failsafe script**: RC off → expected PWMs within the delay; RC on → released; script killed → falls back to GLIDE.
- **Hardware-in-the-loop checklist** on the Matek H743 and F405 Wing before each release.
- **Rule regression set:** a library of "known bad" profiles, seeded from §9, that must be rejected.

## 11. Phased plan

| Phase | Deliverable |
|---|---|
| **0 — Spikes (1–2 wks)** | On both boards: Web Serial + MAVLink connect, full param download, verified write, MAVLink FTP upload, accel cal handshake, mode change while disarmed, bootloader flash from Electron. Failsafe script prototype in SITL and on the H743 with DShot. Receiver detection probe. Metadata and hwdef generation from release tags. |
| **1 — Foundation** | Vehicle layer, backup/restore, raw param editor (Advanced), profile schema + compiler + rules, review/write/verify pipeline, field-check profile diff, firmware manager. |
| **2 — Core wizard** | Steps 1–18. |
| **3 — Failsafe & rest** | Failsafe script + pose solver + step 19, then steps 20–24. |
| **4 — Ship** | Full field check with team checklist and reports, PWA offline, Electron Windows installer, docs, SITL CI. |

## 12. Decisions made

| Decision | Choice |
|---|---|
| Firmware | Latest stable, with one-click upgrade. |
| Allowed modes | MANUAL, FBWA, ACRO. |
| RC-loss behavior | DBF pose (spoilers stowed) via Lua on H7, 1 s after link loss, released when the link returns. GLIDE on F405 and as the fallback everywhere. |
| F405 | Trainer/test only; scripted failsafe and mixing greyed out. |
| Arming | Rudder stick (arm only by default). Nuisance pre-arm checks off; Lua arming gate instead. |
| Mixing | General per-surface mixer; native ArduPilot functions where they match, scripted otherwise. |
| Rules | Severity lives in a team `policy.json`; per-aircraft overrides need a written reason. |
| ESC | Standard ArduPilot DShot settings as the baseline. |
| Platforms | Web + Windows. No macOS. |
| Profiles | Team git repo. |
| Config link | USB. MAVLink over ELRS later. |

## 13. Still open

- **Inspection:** the design shows the failsafe pose while disarmed. Confirm that matches what inspectors expect.
- **ESC:** the Hargrave ran fine on ArduPilot's standard DShot settings, so that's the baseline. Bidirectional DShot stays an option.
- **Code signing for the Windows installer.** Unsigned works, but SmartScreen warns on first run.
- **Phase 0 verifications** listed in §5.7, §5.8 and §6.
