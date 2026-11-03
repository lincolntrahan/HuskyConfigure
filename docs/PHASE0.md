# Phase 0 — results so far

Date: 2026-11-03. Target: ArduPlane **4.7.2** (`fb773567`), latest stable. Everything below ran
against **SITL** (ArduPilot's simulator) in WSL Ubuntu. No flight controller was connected yet,
so every hardware item is still open.

## How to reproduce

```bash
# WSL: once
mkdir -p ~/husky-sitl && cd ~/husky-sitl
wget -O arduplane https://firmware.ardupilot.org/Plane/stable/SITL_x86_64_linux_gnu/arduplane && chmod +x arduplane
wget -O plane.parm https://raw.githubusercontent.com/ArduPilot/ardupilot/fb773567896014da007bca58358704d4a0d8516f/Tools/autotest/models/plane.parm
mkdir -p scripts
# each session (keep this shell open: WSL kills its processes when the launching shell ends)
./arduplane --model plane --defaults plane.parm -I0
```

```bash
npm install
npm test                               # codec unit tests (pymavlink vectors)
npx tsx spikes/sitl-params.ts          # connect, identify, download, verified write
npx tsx spikes/sitl-failsafe.ts        # husky.lua install, gate, failsafe pose, script stop
npx tsx spikes/sitl-gate-edge.ts       # failsafe latency, script-death arming hole
npx tsx spikes/sitl-rudder-arm.ts      # script-owned rudder arming
```

## Results

### MAVLink codec (`packages/mavlink`)
| Check | Result |
|---|---|
| Generated from ArduPilot's `ardupilotmega.xml` | 301 messages, 207 enums |
| CRC_EXTRA vs pymavlink, every message | all 301 match |
| 33 pymavlink-encoded frames (v1 + v2, extensions, char arrays, uint64, 251-byte FTP payload) | all decode correctly and re-encode **byte-identically** |
| Garbage, fake start bytes, random chunking, corrupted frame, signed frame | all pass |
| Bug found and fixed | A fake start byte that decoded to an *unknown* message id made the parser trust its length and skip the real frame behind it. Unverifiable candidates now advance one byte. |

Decision: **use our generated codec.** It's small, browser-safe and proven against the reference.

### Connection and params (`packages/vehicle`)
| Check | Result |
|---|---|
| Heartbeat, identify via `AUTOPILOT_VERSION` | 4.7.2, git `fb773567` |
| Full param download | 1,419 params in **1.4 s** (TCP), 0 CRC errors, gap-fill unused |
| Verified write + restore | OK |
| Out-of-range write `SERVO3_TRIM=99999` | vehicle **silently clamped to 32767**; param manager reports `ok:false`. The tool must range-check against metadata before writing, and always trust only the echo. |
| Param write while armed | refused by the param manager (exercised by accident during a test) |

### Parameter names on 4.7.2 (vs last year's 4.5/4.6 files)
| Last year | 4.7.2 |
|---|---|
| `ARMING_CHECK` | gone → `ARMING_SKIPCHK` (bitmask of checks to **skip**) |
| `SR0_*` … `SR6_*` | gone → `MAV1_*` … |
| `FS_SHORT_TIMEOUT` | gone |
| `FS_SHORT_ACTN=0` / `FS_LONG_ACTN=0` | in MANUAL these mean **CIRCLE then RTL**. Must be `2` (GLIDE = FBWA, throttle 0) for our allowed modes. |

Useful values: skip all but AuxAuth → `ARMING_SKIPCHK = 655358`. Block GCS selection of
everything except MANUAL/ACRO/FBWA → `FLTMODE_GCSBLOCK = 4194254`.

### husky.lua (failsafe pose + arming gate + rudder arming)
| Check | Result |
|---|---|
| Loads, registers `HSK_` params, heartbeat | OK (`SCR_HEAP_SIZE` 204800) |
| Gate: test block / hand-edited config / good config | refuses / refuses / arms |
| RC cut → pose | **1.02 s** with `RC_FS_TIMEOUT=1`, `HSK_FS_DLY=0` |
| Native layer during RC loss | GLIDE (FBWA) |
| RC back → released | ~0.3 s |
| Script stopped mid-failsafe → outputs | released to GLIDE in ~0.22 s |
| **Script died while gate passing → arm?** | **armed.** ArduPilot keeps the last aux-auth "pass". `SCR_RUN_CHECKSUM` didn't stop it either. |
| Fix: script-owned rudder arming (`ARMING_RUDDER=0`) | 2 s hold arms; 1 s hold no; throttle up no; **script stopped: no** |
| Script param table | **must be append-only.** Inserting a slot moved saved failsafe PWMs into the wrong params. |

## Still open in Phase 0
- **Hardware (needs a board on USB):** Web Serial connect and download speed on the Matek H743 and F405 Wing; DShot throttle under the script override; ELRS CRSF vs MAVLink-mode RC-valid behavior; accel cal handshake; reboot and ELRS reconnect.
- **MAVLink FTP upload** of `husky.lua` (SITL used a file copy).
- **Bootloader flashing** and Electron's serial port control.
- **Scripted-surface mixer** in Lua (spoilerons), and what an orphaned scripting output does if the script stops.
- **Metadata and hwdef generators** from release tags (the raw `apm.pdef.json` from master was used ad hoc).
- **Receiver detection** probe.
- Confirm the elevator sign (positive = nose up) on a real surface. The pose relies on it, and the direction checks would catch a mistake.
