import type { ReactNode } from "react";

const BASE = "https://ardupilot.org/plane/docs/";

/** ArduPlane documentation pages the help popups link to (all checked to exist). */
export const DOCS = {
  serial: ["Serial ports", "common-serial-options.html"],
  rc: ["RC receivers", "common-rc-systems.html"],
  elrs: ["ELRS / Crossfire", "common-tbs-rc.html"],
  telemetry: ["Telemetry ports", "common-telemetry-port-setup.html"],
  gps: ["GPS and compass", "common-positioning-landing-page.html"],
  escTelem: ["ESC telemetry", "common-esc-telemetry.html"],
  dshot: ["DShot ESCs", "common-dshot-escs.html"],
  rcCal: ["Radio calibration", "common-radio-control-calibration.html"],
  modes: ["Flight modes", "flight-modes.html"],
  modeSwitch: ["Mode switch setup", "common-rc-transmitter-flight-mode-configuration.html"],
  manual: ["MANUAL mode", "manual-mode.html"],
  fbwa: ["FBWA mode", "fbwa-mode.html"],
  acro: ["ACRO mode", "acro-mode.html"],
  servo: ["Servo output functions", "servo-functions.html"],
  fourCh: ["Servo direction, trim and throw", "guide-four-channel-plane.html"],
  elevon: ["Elevon planes", "guide-elevon-plane.html"],
  vtail: ["V-tail planes", "guide-vtail-plane.html"],
  flaperon: ["Flaperons", "flaperons-on-plane.html"],
  failsafe: ["Failsafe", "apms-failsafe-function.html"],
  arming: ["Arming", "arming-your-plane.html"],
  prearm: ["Pre-arm checks", "common-prearm-safety-checks.html"],
  lua: ["Lua scripts", "common-lua-scripts.html"],
  mounting: ["Board orientation", "common-mounting-the-flight-controller.html"],
  accelCal: ["Accelerometer calibration", "common-accelerometer-calibration.html"],
  params: ["Full parameter list", "parameters.html"],
} as const;
export type DocKey = keyof typeof DOCS;

/** A small "?" that shows longer help (and doc links) on hover or keyboard focus. */
export function Help({ children, docs, right }: { children?: ReactNode; docs?: DocKey[]; right?: boolean }) {
  return (
    <span className={`help ${right ? "right" : ""}`} tabIndex={0} role="button" aria-label="Help">
      ?
      <span className="help-pop" role="tooltip">
        {children}
        {docs && docs.length > 0 && (
          <span className="docs">
            {docs.map((k) => <a key={k} href={BASE + DOCS[k][1]} target="_blank" rel="noreferrer">ArduPlane docs: {DOCS[k][0]} ↗</a>)}
          </span>
        )}
      </span>
    </span>
  );
}
