/** CRC-16/MCRF4XX ("X.25") as used by MAVLink. */
export const X25_INIT = 0xffff;

export function x25Accumulate(crc: number, bytes: Uint8Array, start = 0, end = bytes.length): number {
  for (let i = start; i < end; i++) {
    let tmp = bytes[i]! ^ (crc & 0xff);
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  }
  return crc;
}

export function x25AccumulateByte(crc: number, b: number): number {
  let tmp = (b ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}
