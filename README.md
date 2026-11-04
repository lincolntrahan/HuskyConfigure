# HuskyConfigure

A guided, safety-first configurator for ArduPilot Plane, built for our DBF team.
Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Phase 0 results: [docs/PHASE0.md](docs/PHASE0.md)

## What works today (milestone 1)

- **Connect over USB** (Chrome or Edge), or to the simulator through the dev bridge.
- **Automatic backup** of every parameter on every connect, kept in the browser. Editing stays locked until it exists.
- **Overview:** board, firmware, unique ID, problems the board reported (e.g. a full SD card), message log.
- **Parameters (Advanced):** search by name or description; dropdowns for options, checkboxes for bitmasks, ranges and units from ArduPilot's own docs for the exact firmware; invalid values are blocked.
- **Review → verified write:** every change is listed in plain English, written, then read back. Anything the board clamped or rejected is shown in red.
- **Backups:** download as Mission Planner `.param`; compare any backup (or a `.param` file) with the board and restore selected settings. Calibration values are unticked when the backup came from a different board.
- **Armed lock:** nothing can be written while the board reports armed, enforced below the UI.

Next: the setup wizard (profile, outputs, surfaces, failsafe).

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
