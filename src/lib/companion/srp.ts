/**
 * SRP-6a client (3072-bit group, SHA-512) as used by HomeKit pair-setup.
 * Hashing conventions mirror srptools/pyatv: integers are hashed as minimal
 * big-endian bytes, except where the SRP spec calls for padding (k and u).
 */
import crypto from "node:crypto";
import { GENERATOR, PRIME_3072_HEX } from "./prime";

const N = BigInt("0x" + PRIME_3072_HEX);
const G = GENERATOR;
const N_LEN = PRIME_3072_HEX.length / 2;

function H(...parts: Buffer[]): Buffer {
  const h = crypto.createHash("sha512");
  for (const p of parts) h.update(p);
  return h.digest();
}

function toBig(buf: Buffer): bigint {
  return buf.length === 0 ? 0n : BigInt("0x" + buf.toString("hex"));
}

/** Minimal big-endian bytes (at least one byte), like srptools' int_to_bytes. */
function toMinimal(n: bigint): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

function pad(n: bigint): Buffer {
  const b = toMinimal(n);
  return Buffer.concat([Buffer.alloc(Math.max(0, N_LEN - b.length)), b]);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

export class SrpClient {
  private a: bigint;
  readonly A: bigint;
  private K?: Buffer;
  private M1?: Buffer;
  private Bint?: bigint;

  constructor(
    private username: string,
    private password: string,
    privateKey: Buffer = crypto.randomBytes(64),
  ) {
    this.a = toBig(privateKey);
    this.A = modPow(G, this.a, N);
  }

  get publicKey(): Buffer {
    return toMinimal(this.A);
  }

  /** Processes the server's salt and public value; returns the client proof (M1). */
  process(salt: Buffer, serverPublic: Buffer): Buffer {
    const B = toBig(serverPublic);
    if (B % N === 0n) throw new Error("SRP: invalid server public value");
    this.Bint = B;

    const k = toBig(H(toMinimal(N), pad(G)));
    const u = toBig(H(pad(this.A), pad(B)));
    const x = toBig(
      H(salt, H(Buffer.from(`${this.username}:${this.password}`))),
    );

    const gx = modPow(G, x, N);
    const base = (((B - k * gx) % N) + N) % N;
    const S = modPow(base, this.a + u * x, N);
    this.K = H(toMinimal(S));

    const hN = H(toMinimal(N));
    const hG = H(toMinimal(G));
    const xored = Buffer.alloc(hN.length);
    for (let i = 0; i < xored.length; i++) xored[i] = hN[i] ^ hG[i];

    // A and B are padded to the group size here (matches Apple's implementation; srptools
    // uses minimal bytes, which only differs when A or B has a leading zero byte).
    this.M1 = H(
      xored,
      H(Buffer.from(this.username)),
      salt,
      pad(this.A),
      pad(B),
      this.K,
    );
    return this.M1;
  }

  /** Shared session key K = H(S). Valid after process(). */
  get sessionKey(): Buffer {
    if (!this.K) throw new Error("SRP: process() not called");
    return this.K;
  }

  /** Verifies the server proof M2 = H(A | M1 | K). */
  verifyServerProof(proof: Buffer): boolean {
    if (!this.K || !this.M1) throw new Error("SRP: process() not called");
    const expected = H(pad(this.A), this.M1, this.K);
    return (
      expected.length === proof.length &&
      crypto.timingSafeEqual(expected, proof)
    );
  }
}
