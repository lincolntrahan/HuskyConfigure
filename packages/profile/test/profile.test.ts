import { describe, expect, it } from "vitest";
import {
  compile, decodeTerm, diffCompiled, fallbackFunction, emptyProfile, encodeTerm, evaluate, evalMix, FN, inferProfile,
  nativeFunction, S, spoilerInput, recordCheck, checkStatus, type BoardFacts, type Profile,
} from "../src/index.ts";

/** A board that looks like last year's V2 (H743, 4.7 names), trimmed to what matters here. */
function lastYearBoard(): Map<string, number> {
  const p = new Map<string, number>(Object.entries({
    RCMAP_ROLL: 1, RCMAP_PITCH: 2, RCMAP_THROTTLE: 3, RCMAP_YAW: 4,
    RC1_REVERSED: 0, RC2_REVERSED: 0, RC3_REVERSED: 0, RC4_REVERSED: 0,
    RC1_MIN: 988, RC1_MAX: 2005, RC1_TRIM: 1497, RC2_MIN: 1093, RC2_MAX: 2011, RC2_TRIM: 1603,
    RC3_MIN: 1100, RC3_MAX: 1900, RC3_TRIM: 1500, RC4_MIN: 988, RC4_MAX: 2011, RC4_TRIM: 1512,
    RC7_OPTION: 208, FLTMODE_CH: 8, FLTMODE1: 0, FLTMODE2: 6, FLTMODE3: 0, FLTMODE4: 0, FLTMODE5: 0, FLTMODE6: 10,
    FLTMODE_GCSBLOCK: 0, INITIAL_MODE: 0,
    SERIAL2_PROTOCOL: 2, SERIAL4_PROTOCOL: 5, SERIAL6_PROTOCOL: 16, SERIAL7_PROTOCOL: 23, SERIAL7_BAUD: 57,
    RSSI_TYPE: 3, RC_OPTIONS: 32,
    SERVO_BLH_MASK: 1, SERVO_BLH_OTYPE: 5, SERVO_BLH_BDMASK: 1, SERVO_BLH_POLES: 1,
    THR_FAILSAFE: 0, FS_SHORT_ACTN: 0, FS_LONG_ACTN: 0, RC_FS_TIMEOUT: 1, FS_GCS_ENABL: 0, AFS_ENABLE: 0,
    ARMING_REQUIRE: 1, ARMING_RUDDER: 2, ARMING_SKIPCHK: 0, SCR_ENABLE: 1, MIXING_GAIN: 0.5,
  }));
  const servos: [number, number, number, number, number, number][] = [
    // n, function, reversed, trim, min, max
    [1, 70, 0, 1000, 1000, 2000], [2, 0, 0, 1500, 1100, 1900], [3, 80, 1, 1450, 1000, 1890], [4, 79, 0, 1500, 1100, 1990],
    [5, 21, 1, 1500, 1100, 1900], [6, 25, 0, 1590, 1000, 1900], [7, 146, 1, 1450, 1000, 1775], [8, 24, 0, 1440, 1100, 2000],
    [9, 146, 0, 1375, 1045, 1900], [10, 0, 0, 1500, 1100, 1900], [11, 154, 0, 1501, 1100, 1900], [12, 153, 0, 1500, 1100, 1900],
    [13, 0, 0, 1500, 1100, 1900], [14, 0, 0, 1500, 1100, 1900], [15, 0, 0, 1500, 1100, 1900], [16, 138, 0, 1500, 1100, 1900],
  ];
  for (const [n, fn, rev, trim, min, max] of servos) {
    p.set(`SERVO${n}_FUNCTION`, fn); p.set(`SERVO${n}_REVERSED`, rev);
    p.set(`SERVO${n}_TRIM`, trim); p.set(`SERVO${n}_MIN`, min); p.set(`SERVO${n}_MAX`, max);
  }
  return p;
}
const facts = (params: Map<string, number>, hasScripting = true): BoardFacts => ({ params, hasScripting, outputs: 16 });

describe("native function matching", () => {
  const prof = { inputs: [spoilerInput(7)] };
  it.each([
    [S.aileronL(), FN.AILERON, true], [S.aileronR(), FN.AILERON, false], [S.elevator(), FN.ELEVATOR, false],
    [S.rudder(), FN.RUDDER, false], [S.steering(), FN.GROUND_STEERING, false],
    [S.elevonL(), FN.ELEVON_LEFT, false], [S.elevonR(), FN.ELEVON_RIGHT, false],
    [S.ruddervatorL(), FN.VTAIL_LEFT, false], [S.ruddervatorR(), FN.VTAIL_RIGHT, false],
    [S.flaperonL(), FN.FLAPERON_LEFT, true], [S.flaperonR(), FN.FLAPERON_RIGHT, false],
    [S.flapL(), FN.FLAP_AUTO, true], [S.spoilerL(), FN.RCIN1_SCALED + 6, false],
  ])("%o", (s, fn, invert) => {
    const m = nativeFunction(s, prof);
    expect(m?.fn).toBe(fn);
    expect(m?.invert).toBe(invert);
  });
  it("spoilerons and one-sided curves are scripted, with safe fallbacks", () => {
    expect(nativeFunction(S.spoileronL(), prof)).toBeUndefined();
    const upper = { ...S.spoilerR(), mix: [{ in: "roll", w: 1, curve: "positive" as const }, { in: "spoiler", w: 1 }] };
    expect(nativeFunction(upper, prof)).toBeUndefined();
    expect(fallbackFunction(S.spoileronL(), prof)).toMatchObject({ fn: FN.AILERON, invert: true });
    expect(fallbackFunction(upper, prof).fn).toBe(FN.SERVO_TRIM); // never "un-curve" a one-sided term
  });
  it("mirrors ArduPilot's channel_function_mixer for V-tail and elevons", () => {
    // right ruddervator = (elevator - rudder): pitch up raises it, yaw right lowers it
    expect(evalMix(S.ruddervatorR().mix, { pitch: 0.5, yaw: 0.5 })).toBe(0);
    expect(evalMix(S.elevonL().mix, { pitch: 1, roll: 1 })).toBe(0);
    expect(evalMix(S.elevonL().mix, { pitch: 1, roll: -1 })).toBe(1);
  });
});

describe("term encoding for husky.lua", () => {
  it("round-trips", () => {
    const p = { inputs: [spoilerInput(7)] };
    for (const t of [{ in: "roll", w: -1 }, { in: "spoiler", w: 0.5 }, { in: "rc9", w: 0.25, curve: "positive" as const }]) {
      const d = decodeTerm(encodeTerm(t, p));
      expect(d.w).toBeCloseTo(t.w);
      expect(Number.isInteger(encodeTerm(t, p))).toBe(true);
    }
    expect(decodeTerm(encodeTerm({ in: "spoiler", w: 1 }, p)).id).toBe(207);
  });
});

describe("import from board", () => {
  it("reproduces last year's outputs exactly when recompiled", () => {
    const board = lastYearBoard();
    const prof = inferProfile(board);
    const c = compile(prof, facts(board));
    for (let n = 1; n <= 16; n++) {
      expect(c.params[`SERVO${n}_FUNCTION`], `S${n}`).toBe(board.get(`SERVO${n}_FUNCTION`));
      if (board.get(`SERVO${n}_FUNCTION`)) expect(c.params[`SERVO${n}_REVERSED`] ?? board.get(`SERVO${n}_REVERSED`), `S${n} rev`).toBe(board.get(`SERVO${n}_REVERSED`));
    }
    expect(prof.motors[0]).toMatchObject({ output: 1, protocol: "DSHOT300", bidir: true });
    expect(prof.flapChannel).toBe(7);
    const outDiff = diffCompiled(c, board, ["outputs", "directions", "trims"]);
    expect(outDiff).toEqual([]);
  });

  it("flags last year's problems", () => {
    const board = lastYearBoard();
    const prof = inferProfile(board);
    const c = compile(prof, facts(board));
    const f = evaluate(prof, c, { ...facts(board), target: "MatekH743-bdshot" });
    const rules = f.map((x) => x.rule);
    expect(rules).toContain("mode-not-allowed");      // FBWB and AUTO on the switch
    expect(rules).toContain("failsafe-not-captured");
    expect(rules).toContain("trim-off-center");       // S6 at 1590, S9 at 1375
    // compiling fixes the dangerous defaults
    expect(c.params).toMatchObject({ THR_FAILSAFE: 1, FS_SHORT_ACTN: 2, FS_LONG_ACTN: 2, ARMING_RUDDER: 0, FLTMODE_GCSBLOCK: 4194254 });
  });
});

describe("compile", () => {
  function spoileronPlane(): Profile {
    const p = emptyProfile("Test");
    p.inputs = [spoilerInput(7)];
    p.surfaces = [{ ...S.spoileronL(), output: 6 }, { ...S.spoileronR(), output: 8 }, { ...S.elevator(), output: 3 }, { ...S.rudder(), output: 4 }];
    p.motors = [{ id: "m", name: "Motor", position: "center", output: 1, protocol: "DSHOT600", bidir: false, telemetry: "serial", telemetrySerial: 6, poles: 14 }];
    return p;
  }
  it("scripts spoilerons on top of a native aileron fallback and encodes the mix", () => {
    const board = lastYearBoard();
    const c = compile(spoileronPlane(), facts(board));
    expect(c.params.SERVO6_FUNCTION).toBe(FN.AILERON); // if the script stops, still an aileron
    expect(c.params.SERVO8_FUNCTION).toBe(FN.AILERON);
    expect(c.params.HSK_MIX_N).toBe(2);
    expect(c.params.HSK_M1_OUT).toBe(-6); // left: mix is roll -1, aileron is roll +1 → script flips
    expect(c.params.HSK_M2_OUT).toBe(8);
    expect(c.params.SERVO6_REVERSED).toBeUndefined(); // decided by the direction check, not guessed
    expect(decodeTerm(c.params.HSK_M1_T2!).id).toBe(207);
    expect(c.params.SERVO_BLH_MASK).toBe(1);
    expect(c.params.SERVO_BLH_OTYPE).toBe(6);
    expect(c.params.SERIAL6_PROTOCOL).toBe(16);
    expect(c.params.SERVO2_FUNCTION).toBe(0); // last year's leftovers disabled
    expect(c.absent).toContain("HSK_MIX_N"); // script not running on this fake board
  });
  it("flags a servo sharing the DShot motor's timer", () => {
    const p = spoileronPlane();
    p.surfaces[3]!.output = 2; // rudder on S2, same timer as the motor on S1
    const board = lastYearBoard();
    const f = evaluate(p, compile(p, facts(board)), { ...facts(board), timerGroups: [[1, 2], [3, 4, 5, 6], [7, 8, 9, 10]] });
    expect(f.find((x) => x.rule === "dshot-timer")?.severity).toBe("error");
  });
  it("F4 board: no scripting means GLIDE, native rudder arming, all checks skipped", () => {
    const p = emptyProfile();
    p.failsafe.mode = "glide";
    const board = lastYearBoard();
    board.delete("SCR_ENABLE");
    const c = compile(p, facts(board, false));
    expect(c.params.ARMING_RUDDER).toBe(1);
    expect(c.params.ARMING_SKIPCHK).toBe(-1);
    expect(c.params.HSK_ENABLE).toBeUndefined();
  });
  it("policy overrides relax a rule with a recorded reason, core rules stay", () => {
    const p = spoileronPlane();
    p.surfaces[0]!.trim = 1600;
    p.overrides = [{ rule: "trim-off-center", reason: "Linkage fixed next build" }];
    const board = lastYearBoard();
    const f = evaluate(p, compile(p, facts(board)), facts(board));
    expect(f.find((x) => x.rule === "trim-off-center")).toMatchObject({ severity: "info", overridden: "Linkage fixed next build" });
  });
});

describe("verification ledger", () => {
  it("goes stale when a dependent parameter changes", () => {
    const board = lastYearBoard();
    let p = inferProfile(board);
    const s = p.surfaces.find((x) => x.output === 5)!;
    p = recordCheck(`direction:${s.id}`, p, board);
    expect(checkStatus(`direction:${s.id}`, p, board)).toBe("ok");
    board.set("SERVO5_REVERSED", 0);
    expect(checkStatus(`direction:${s.id}`, p, board)).toBe("stale");
    board.set("SERVO7_REVERSED", 0); // unrelated output
    board.set("SERVO5_REVERSED", 1);
    expect(checkStatus(`direction:${s.id}`, p, board)).toBe("ok");
  });
});
