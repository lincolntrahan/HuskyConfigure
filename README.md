# HuskyConfigure

A guided, safety-first configurator for ArduPilot Plane, built for our DBF team.
Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Phase 0 results: [docs/PHASE0.md](docs/PHASE0.md)

## What works today

### Milestone 1: connect, back up, edit, restore

- **Connect over USB** (Chrome or Edge), or to the simulator through the dev bridge.
- **Automatic backup** of every parameter on every connect, kept in the browser. Editing stays locked until it exists.
- **Overview:** board, firmware, unique ID, problems the board reported (e.g. a full SD card), message log.
- **Parameters (Advanced):** search by name or description; dropdowns for options, checkboxes for bitmasks, ranges and units from ArduPilot's own docs for the exact firmware; invalid values are blocked.
- **Review → verified write:** every change is listed in plain English, written, then read back. Anything the board clamped or rejected is shown in red.
- **Backups:** download as Mission Planner `.param`; compare any backup (or a `.param` file) with the board and restore selected settings. Calibration values are unticked when the backup came from a different board.
- **Armed lock:** nothing can be written while the board reports armed, enforced below the UI.

## Setup wizard (milestone 2)

The wizard edits an **aircraft profile** (saved per board in the browser; *Save profile file* for the team repo) and compiles it to parameters. Each step applies only its own settings, through the same review and verified write.

| Step | What it does |
|---|---|
| Aircraft | Start from the board's current setup (import changes nothing until you edit), start fresh, or open a profile file. |
| Receiver | ELRS CRSF / MAVLink / SBUS, on which pads; live RC check. |
| Sticks | Move each stick when asked: the tool finds the channel and its direction (catches reversed radios), then measures stick travel. |
| Flight modes | MANUAL / FBWA / ACRO only; Mission Planner is blocked from selecting anything else. |
| Airframe | Templates (conventional, V-tail, flying wing, flaperons, spoilerons) and a per-surface mix editor. Each surface shows whether ArduPilot mixes it natively or the companion script does, and what it falls back to if the script stops. |
| Outputs | Which pad each servo/ESC is on, with the board's real timer groups (read from the board); DShot / bidirectional / ESC telemetry. Unused outputs are switched off. |
| Companion script | Installs `husky.lua` over USB (MAVLink FTP), verifies it, reboots and reconnects. |
| Surface directions | One input at a time: the tool waits until it *sees* the output move, you say which way it went, wrong answers are fixed on the spot (servo reversed, or mix sign for a wrong-side surface). |
| Trim and throws | Live center and end-point adjustment. |
| Stabilization check | FBWA tilt test (board attitude confirmed before you answer). |
| Failsafe | Captures the DBF pose from the board itself (sticks held by RC override, disarmed, MANUAL), applies it, then the transmitter-off test with a per-surface checklist. |
| Arming | Rudder-stick arming through the script; nuisance pre-arm checks off. |
| Finish | Every rule finding, every physical check, and anything still different from the board. |

Physical checks are bound to the exact parameters they were done with: change one of them later and the check goes back to "needs re-check".

Not in the wizard yet: orientation/accelerometer calibration, compass, GPS, airspeed, battery, logging, firmware updates.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173 in **Chrome or Edge**, plug in the flight controller, and click **Connect USB**.

### With the simulator (no hardware)

Start SITL in WSL (see [docs/PHASE0.md](docs/PHASE0.md)), then in a second terminal:

```bash
npm run bridge:sitl
```

In the app, open **Advanced: simulator / bridge** on the Connect page and click **Connect bridge**.

## Checks

```bash
npm test
npm run typecheck
```

## Parameter docs for a new firmware release

Generated from ArduPilot's source at the release tag (here in WSL):

```bash
git clone --depth 1 --branch Plane-4.7.2 --filter=blob:none https://github.com/ArduPilot/ardupilot.git ~/ardupilot-4.7.2
cd /tmp && python3 ~/ardupilot-4.7.2/Tools/autotest/param_metadata/param_parse.py --vehicle ArduPlane --format json
```

Then convert it and register the version in `packages/metadata/src/index.ts`:

```bash
npm run gen:metadata -- path/to/apm.pdef.json 4.7.2 "param_parse.py at tag Plane-4.7.2"
```
