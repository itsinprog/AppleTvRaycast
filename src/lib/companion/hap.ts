/** Thin wrappers over node:crypto for the primitives HomeKit pairing needs. */
import crypto from "node:crypto";

const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");

export function hkdfSha512(
  salt: string,
  info: string,
  ikm: Buffer,
  length = 32,
): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha512",
      ikm,
      Buffer.from(salt),
      Buffer.from(info),
      length,
    ),
  );
}

/** ChaCha20-Poly1305 encrypt. Output is ciphertext followed by the 16-byte tag. */
export function chachaEncrypt(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
  aad?: Buffer,
): Buffer {
  const cipher = crypto.createCipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: 16,
  });
  if (aad) cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]);
}

export function chachaDecrypt(
  key: Buffer,
  nonce: Buffer,
  data: Buffer,
  aad?: Buffer,
): Buffer {
  const body = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: 16,
  });
  if (aad) decipher.setAAD(aad, { plaintextLength: body.length });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** HAP "named" nonces are an ASCII label left-padded with zeros to 12 bytes. */
export function labelNonce(label: string): Buffer {
  const out = Buffer.alloc(12);
  Buffer.from(label).copy(out, 12 - label.length);
  return out;
}

export function counterNonce(counter: number): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64LE(BigInt(counter), 0);
  return out;
}

export function ed25519PublicFromSeed(seed: Buffer): Buffer {
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = crypto
    .createPublicKey(priv)
    .export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32));
}

export function ed25519Sign(seed: Buffer, data: Buffer): Buffer {
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8, seed]),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, data, priv);
}

export function ed25519Verify(
  publicKey: Buffer,
  signature: Buffer,
  data: Buffer,
): boolean {
  const pub = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI, publicKey]),
    format: "der",
    type: "spki",
  });
  return crypto.verify(null, data, pub, signature);
}

export interface X25519Pair {
  publicKey: Buffer;
  agree(peerPublic: Buffer): Buffer;
}

export function x25519Generate(): X25519Pair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey: Buffer.from(spki.subarray(spki.length - 32)),
    agree(peerPublic: Buffer) {
      const peer = crypto.createPublicKey({
        key: Buffer.concat([X25519_SPKI, peerPublic]),
        format: "der",
        type: "spki",
      });
      return crypto.diffieHellman({ privateKey, publicKey: peer });
    },
  };
}
