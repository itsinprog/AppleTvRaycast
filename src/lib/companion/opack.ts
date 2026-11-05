/**
 * OPACK: Apple's compact binary serialization used by the Companion protocol.
 * Port of the behaviour documented by pyatv (pyatv/support/opack.py).
 * Not implemented: absolute time (0x06 is read as an integer), UID reuse when packing.
 */

/** Marks a number that must be encoded as a float64 instead of an integer. */
export class OpackFloat {
  constructor(public value: number) {}
}

export type OpackValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Buffer
  | OpackFloat
  | OpackValue[]
  | { [key: string]: OpackValue };

function uintLE(value: number | bigint, size: number): Buffer {
  const out = Buffer.alloc(size);
  let v = BigInt(value);
  for (let i = 0; i < size; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function pack(value: OpackValue): Buffer {
  if (value === null) return Buffer.from([0x04]);
  if (typeof value === "boolean") return Buffer.from([value ? 1 : 2]);
  if (value instanceof OpackFloat) {
    const b = Buffer.alloc(9);
    b[0] = 0x36;
    b.writeDoubleLE(value.value, 1);
    return b;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const n = BigInt(value);
    if (n < 0n)
      throw new TypeError("OPACK: negative integers are not supported");
    if (n < 0x28n) return Buffer.from([Number(n) + 8]);
    if (n <= 0xffn) return Buffer.concat([Buffer.from([0x30]), uintLE(n, 1)]);
    if (n <= 0xffffn) return Buffer.concat([Buffer.from([0x31]), uintLE(n, 2)]);
    if (n <= 0xffffffffn)
      return Buffer.concat([Buffer.from([0x32]), uintLE(n, 4)]);
    return Buffer.concat([Buffer.from([0x33]), uintLE(n, 8)]);
  }
  if (typeof value === "string") {
    const enc = Buffer.from(value, "utf8");
    if (enc.length <= 0x20)
      return Buffer.concat([Buffer.from([0x40 + enc.length]), enc]);
    if (enc.length <= 0xff)
      return Buffer.concat([Buffer.from([0x61]), uintLE(enc.length, 1), enc]);
    if (enc.length <= 0xffff)
      return Buffer.concat([Buffer.from([0x62]), uintLE(enc.length, 2), enc]);
    return Buffer.concat([Buffer.from([0x64]), uintLE(enc.length, 4), enc]);
  }
  if (Buffer.isBuffer(value)) {
    if (value.length <= 0x20)
      return Buffer.concat([Buffer.from([0x70 + value.length]), value]);
    if (value.length <= 0xff)
      return Buffer.concat([
        Buffer.from([0x91]),
        uintLE(value.length, 1),
        value,
      ]);
    if (value.length <= 0xffff)
      return Buffer.concat([
        Buffer.from([0x92]),
        uintLE(value.length, 2),
        value,
      ]);
    return Buffer.concat([Buffer.from([0x93]), uintLE(value.length, 4), value]);
  }
  if (Array.isArray(value)) {
    const parts = [
      Buffer.from([0xd0 + Math.min(value.length, 0xf)]),
      ...value.map(pack),
    ];
    if (value.length >= 0xf) parts.push(Buffer.from([0x03]));
    return Buffer.concat(parts);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    const parts: Buffer[] = [
      Buffer.from([0xe0 + Math.min(entries.length, 0xf)]),
    ];
    for (const [k, v] of entries) parts.push(pack(k), pack(v));
    if (entries.length >= 0xf) parts.push(Buffer.from([0x03]));
    return Buffer.concat(parts);
  }
  throw new TypeError(`OPACK: unsupported type ${typeof value}`);
}

function sameValue(a: OpackValue, b: OpackValue): boolean {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  return a === b;
}

export function unpack(data: Buffer): OpackValue {
  const [value] = unpackAt(data, 0, []);
  return value;
}

function readUintLE(
  data: Buffer,
  offset: number,
  size: number,
): number | bigint {
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function unpackAt(
  data: Buffer,
  pos: number,
  objects: OpackValue[],
): [OpackValue, number] {
  const tag = data[pos];
  if (tag === undefined) throw new RangeError("OPACK: unexpected end of data");
  let value: OpackValue;
  let next: number;
  let track = true;

  if (tag === 0x01) [value, next, track] = [true, pos + 1, false];
  else if (tag === 0x02) [value, next, track] = [false, pos + 1, false];
  else if (tag === 0x04) [value, next, track] = [null, pos + 1, false];
  else if (tag === 0x05) {
    value = data.subarray(pos + 1, pos + 17).toString("hex"); // UUID, returned as hex
    next = pos + 17;
  } else if (tag === 0x06) {
    value = readUintLE(data, pos + 1, 8);
    next = pos + 9;
  } else if (tag >= 0x08 && tag <= 0x2f)
    [value, next, track] = [tag - 8, pos + 1, false];
  else if (tag === 0x35) [value, next] = [data.readFloatLE(pos + 1), pos + 5];
  else if (tag === 0x36) [value, next] = [data.readDoubleLE(pos + 1), pos + 9];
  else if ((tag & 0xf0) === 0x30) {
    const size = 2 ** (tag & 0xf);
    value = readUintLE(data, pos + 1, size);
    next = pos + 1 + size;
  } else if (tag >= 0x40 && tag <= 0x60) {
    const len = tag - 0x40;
    value = data.toString("utf8", pos + 1, pos + 1 + len);
    next = pos + 1 + len;
  } else if (tag > 0x60 && tag <= 0x64) {
    const size = tag & 0xf;
    const len = Number(readUintLE(data, pos + 1, size));
    value = data.toString("utf8", pos + 1 + size, pos + 1 + size + len);
    next = pos + 1 + size + len;
  } else if (tag >= 0x70 && tag <= 0x90) {
    const len = tag - 0x70;
    value = Buffer.from(data.subarray(pos + 1, pos + 1 + len));
    next = pos + 1 + len;
  } else if (tag >= 0x91 && tag <= 0x94) {
    const size = 1 << ((tag & 0xf) - 1);
    const len = Number(readUintLE(data, pos + 1, size));
    value = Buffer.from(data.subarray(pos + 1 + size, pos + 1 + size + len));
    next = pos + 1 + size + len;
  } else if ((tag & 0xf0) === 0xd0) {
    const count = tag & 0xf;
    const out: OpackValue[] = [];
    let p = pos + 1;
    if (count === 0xf) {
      while (data[p] !== 0x03) {
        const [v, np] = unpackAt(data, p, objects);
        out.push(v);
        p = np;
      }
      p += 1;
    } else {
      for (let i = 0; i < count; i++) {
        const [v, np] = unpackAt(data, p, objects);
        out.push(v);
        p = np;
      }
    }
    [value, next, track] = [out, p, false];
  } else if ((tag & 0xf0) === 0xe0) {
    const count = tag & 0xf;
    const out: { [key: string]: OpackValue } = {};
    let p = pos + 1;
    const readPair = () => {
      const [k, p1] = unpackAt(data, p, objects);
      const [v, p2] = unpackAt(data, p1, objects);
      out[String(k)] = v;
      p = p2;
    };
    if (count === 0xf) {
      while (data[p] !== 0x03) readPair();
      p += 1;
    } else {
      for (let i = 0; i < count; i++) readPair();
    }
    [value, next, track] = [out, p, false];
  } else if (tag >= 0xa0 && tag <= 0xc0) {
    [value, next, track] = [objects[tag - 0xa0], pos + 1, false];
  } else if (tag >= 0xc1 && tag <= 0xc4) {
    const size = tag - 0xc0;
    value = objects[Number(readUintLE(data, pos + 1, size))];
    next = pos + 1 + size;
    track = false;
  } else {
    throw new TypeError(`OPACK: unsupported tag 0x${tag.toString(16)}`);
  }

  if (track && !objects.some((o) => sameValue(o, value))) objects.push(value);
  return [value, next];
}
