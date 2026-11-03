/** [name, type, arrayLen (0 = scalar), isExtension (0/1)] in wire order. */
export type FieldTuple = readonly [string, string, number, number];

export interface MessageDef {
  id: number;
  name: string;
  crcExtra: number;
  /** payload length without extensions */
  minLen: number;
  /** payload length with extensions */
  maxLen: number;
  fields: readonly FieldTuple[];
}

export type FieldValue = number | bigint | string | number[] | bigint[];
export type Payload = Record<string, FieldValue>;

export interface Frame {
  version: 1 | 2;
  seq: number;
  sysid: number;
  compid: number;
  msgid: number;
  /** raw payload as received (may be truncated in v2) */
  payload: Uint8Array;
  signed: boolean;
}

export interface DecodedMessage<T = Payload> {
  name: string;
  msgid: number;
  sysid: number;
  compid: number;
  seq: number;
  fields: T;
}
