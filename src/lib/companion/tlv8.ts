/** TLV8 as used by HomeKit pairing. Values over 255 bytes are split across repeated tags. */

export enum Tlv {
  Method = 0x00,
  Identifier = 0x01,
  Salt = 0x02,
  PublicKey = 0x03,
  Proof = 0x04,
  EncryptedData = 0x05,
  SeqNo = 0x06,
  Error = 0x07,
  BackOff = 0x08,
  Signature = 0x0a,
  Name = 0x11,
}

export function readTlv(data: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  let pos = 0;
  while (pos + 2 <= data.length) {
    const tag = data[pos];
    const len = data[pos + 1];
    const value = data.subarray(pos + 2, pos + 2 + len);
    const prev = out.get(tag);
    out.set(tag, prev ? Buffer.concat([prev, value]) : Buffer.from(value));
    pos += 2 + len;
  }
  return out;
}

export function writeTlv(entries: Array<[number, Buffer]>): Buffer {
  const parts: Buffer[] = [];
  for (const [tag, value] of entries) {
    for (let pos = 0; pos < value.length; pos += 255) {
      const chunk = value.subarray(pos, Math.min(pos + 255, value.length));
      parts.push(Buffer.from([tag, chunk.length]), chunk);
    }
  }
  return Buffer.concat(parts);
}

const ERROR_NAMES: Record<number, string> = {
  1: "Unknown",
  2: "Authentication (wrong PIN?)",
  3: "Back-off (too many attempts, wait and retry)",
  4: "Max peers reached",
  5: "Max tries exceeded",
  6: "Unavailable",
  7: "Busy",
};

export function describeTlvError(code: Buffer): string {
  const n = code.readUIntLE(0, Math.min(code.length, 6));
  return ERROR_NAMES[n] ?? `error ${n}`;
}
