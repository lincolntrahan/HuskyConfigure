/**
 * Starting points for the Airframe step. They only pre-fill surfaces and mixes; every mix stays
 * editable. Signs follow the "+ = trailing edge up / right" convention in types.ts.
 */
import type { CustomInput, Motor, Silhouette, Surface } from "./types.ts";

let n = 0;
const id = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;

export const S = {
  aileronL: (): Surface => ({ id: id("ail-l"), name: "Left aileron", kind: "aileron", side: "left", mix: [{ in: "roll", w: -1 }], failsafe: "pose", autoName: true }),
  aileronR: (): Surface => ({ id: id("ail-r"), name: "Right aileron", kind: "aileron", side: "right", mix: [{ in: "roll", w: 1 }], failsafe: "pose", autoName: true }),
  elevator: (): Surface => ({ id: id("elev"), name: "Elevator", kind: "elevator", side: "center", mix: [{ in: "pitch", w: 1 }], failsafe: "pose", autoName: true }),
  rudder: (): Surface => ({ id: id("rud"), name: "Rudder", kind: "rudder", side: "center", upright: true, mix: [{ in: "yaw", w: 1 }], failsafe: "pose", autoName: true }),
  steering: (): Surface => ({ id: id("steer"), name: "Tailwheel steering", kind: "steering", side: "center", upright: true, groundSteering: false, mix: [{ in: "yaw", w: 1 }], failsafe: "pose", autoName: false }),
  ruddervatorL: (): Surface => ({ id: id("rv-l"), name: "Left ruddervator", kind: "ruddervator", side: "left", mix: [{ in: "pitch", w: 1 }, { in: "yaw", w: 1 }], failsafe: "pose", autoName: true }),
  ruddervatorR: (): Surface => ({ id: id("rv-r"), name: "Right ruddervator", kind: "ruddervator", side: "right", mix: [{ in: "pitch", w: 1 }, { in: "yaw", w: -1 }], failsafe: "pose", autoName: true }),
  elevonL: (): Surface => ({ id: id("elv-l"), name: "Left elevon", kind: "elevon", side: "left", mix: [{ in: "pitch", w: 1 }, { in: "roll", w: -1 }], failsafe: "pose", autoName: true }),
  elevonR: (): Surface => ({ id: id("elv-r"), name: "Right elevon", kind: "elevon", side: "right", mix: [{ in: "pitch", w: 1 }, { in: "roll", w: 1 }], failsafe: "pose", autoName: true }),
  flaperonL: (): Surface => ({ id: id("flp-l"), name: "Left flaperon", kind: "flaperon", side: "left", mix: [{ in: "roll", w: -1 }, { in: "flap", w: -1 }], failsafe: "pose", autoName: true }),
  flaperonR: (): Surface => ({ id: id("flp-r"), name: "Right flaperon", kind: "flaperon", side: "right", mix: [{ in: "roll", w: 1 }, { in: "flap", w: -1 }], failsafe: "pose", autoName: true }),
  flapL: (): Surface => ({ id: id("flap-l"), name: "Left flap", kind: "flap", side: "left", mix: [{ in: "flap", w: -1 }], failsafe: "pose", autoName: true }),
  flapR: (): Surface => ({ id: id("flap-r"), name: "Right flap", kind: "flap", side: "right", mix: [{ in: "flap", w: -1 }], failsafe: "pose", autoName: true }),
  spoilerL: (): Surface => ({ id: id("spl-l"), name: "Left spoiler", kind: "spoiler", side: "left", mix: [{ in: "spoiler", w: 1 }], failsafe: "pose", autoName: true }),
  spoilerR: (): Surface => ({ id: id("spl-r"), name: "Right spoiler", kind: "spoiler", side: "right", mix: [{ in: "spoiler", w: 1 }], failsafe: "pose", autoName: true }),
  /** an aileron that also rises with the spoiler input */
  spoileronL: (): Surface => ({ id: id("spn-l"), name: "Left spoileron", kind: "spoileron", side: "left", mix: [{ in: "roll", w: -1 }, { in: "spoiler", w: 0.5 }], failsafe: "pose", autoName: true }),
  spoileronR: (): Surface => ({ id: id("spn-r"), name: "Right spoileron", kind: "spoileron", side: "right", mix: [{ in: "roll", w: 1 }, { in: "spoiler", w: 0.5 }], failsafe: "pose", autoName: true }),
  mechanism: (rc: number, name = `Mechanism on RC${rc}`): Surface => ({ id: id("mech"), name, kind: "mechanism", side: "center", mix: [{ in: `rc${rc}`, w: 1 }], failsafe: "hold", autoName: false }),
};

export const spoilerInput = (rc = 7): CustomInput => ({ id: "spoiler", label: "Spoilers", rc, range: "unipolar" });

export const motor = (): Motor => ({ id: id("motor"), name: "Motor", position: "center", protocol: "DSHOT300", bidir: false, telemetry: "none", poles: 14 });

export interface Template { id: string; label: string; description: string; surfaces: () => Surface[]; needsSpoilerInput?: boolean; silhouette: Silhouette }

export const TEMPLATES: Template[] = [
  { id: "conventional", silhouette: "conventional", label: "Conventional", description: "Two ailerons, elevator, rudder", surfaces: () => [S.aileronL(), S.aileronR(), S.elevator(), S.rudder()] },
  { id: "vtail", silhouette: "vtail", label: "V-tail", description: "Two ailerons, two ruddervators", surfaces: () => [S.aileronL(), S.aileronR(), S.ruddervatorL(), S.ruddervatorR()] },
  { id: "wing", silhouette: "wing", label: "Flying wing", description: "Two elevons", surfaces: () => [S.elevonL(), S.elevonR()] },
  { id: "flaperon", silhouette: "conventional", label: "Flaperons", description: "Flaperons, elevator, rudder", surfaces: () => [S.flaperonL(), S.flaperonR(), S.elevator(), S.rudder()] },
  { id: "spoileron", silhouette: "conventional", label: "Spoilerons", description: "Ailerons that also rise as spoilers, elevator, rudder", surfaces: () => [S.spoileronL(), S.spoileronR(), S.elevator(), S.rudder()], needsSpoilerInput: true },
  { id: "blank", silhouette: "conventional", label: "Blank", description: "Add surfaces yourself", surfaces: () => [] },
];
