// Test helper: reads {hex, expected-json} cases from stdin, unpacks, prints JSON; also packs given JSON specs.
import { OpackFloat, OpackValue, pack, unpack } from "../src/lib/companion/opack";
import fs from "node:fs";

const cases = JSON.parse(fs.readFileSync(0, "utf8")) as { hex: string }[];
const unpacked = cases.map((c) => {
  const v = unpack(Buffer.from(c.hex, "hex"));
  return JSON.stringify(v, (_, x) => (Buffer.isBuffer(x) ? { __b: x.toString("hex") } : x && x.type === "Buffer" ? { __b: Buffer.from(x.data).toString("hex") } : typeof x === "bigint" ? Number(x) : x));
});
const sample: OpackValue = {
  _i: "_systemInfo",
  _t: 2,
  _c: { _bf: 0, _cf: 512, _clFl: 128, _idsID: Buffer.from("ABCDEF", "hex"), _height: new OpackFloat(1000), big: 70000, huge: 5000000000, list: [1, "a", true, null], long: "x".repeat(40) },
  _x: 12345,
};
console.log(JSON.stringify({ unpacked, packed: pack(sample).toString("hex") }));
