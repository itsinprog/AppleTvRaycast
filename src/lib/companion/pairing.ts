/** HomeKit-style pair-setup (one-time, PIN) and pair-verify (per connection). */
import crypto from "node:crypto";
import {
  chachaDecrypt,
  chachaEncrypt,
  ed25519PublicFromSeed,
  ed25519Sign,
  ed25519Verify,
  hkdfSha512,
  labelNonce,
  x25519Generate,
} from "./hap";
import { pack } from "./opack";
import { CompanionSession, FrameType } from "./session";
import { SrpClient } from "./srp";
import { Tlv, describeTlvError, readTlv, writeTlv } from "./tlv8";

export interface Credentials {
  /** Apple TV long-term public key. */
  ltpk: Buffer;
  /** Our long-term Ed25519 private seed. */
  ltsk: Buffer;
  /** Apple TV pairing identifier. */
  atvId: Buffer;
  /** Our pairing identifier. */
  clientId: Buffer;
}

/** Same `ltpk:ltsk:atvid:clientid` hex format pyatv uses, so credentials are interchangeable. */
export function serializeCredentials(c: Credentials): string {
  return [c.ltpk, c.ltsk, c.atvId, c.clientId]
    .map((b) => b.toString("hex"))
    .join(":");
}

export function parseCredentials(text: string): Credentials {
  const parts = text.trim().split(":");
  if (parts.length !== 4) throw new Error("Invalid credentials");
  const [ltpk, ltsk, atvId, clientId] = parts.map((p) => Buffer.from(p, "hex"));
  return { ltpk, ltsk, atvId, clientId };
}

/** The Apple TV is rate-limiting pairing attempts and refuses new ones for a while. */
export class PairingBackoffError extends Error {
  constructor(public readonly seconds: number) {
    super(`The Apple TV is rate-limiting pairing. Try again in ${seconds}s.`);
  }
}

function pairingData(response: Record<string, unknown>): Map<number, Buffer> {
  const pd = response["_pd"];
  if (!Buffer.isBuffer(pd)) throw new Error("Apple TV sent no pairing data");
  const tlv = readTlv(pd);
  const err = tlv.get(Tlv.Error);
  if (err) {
    if (err.readUIntLE(0, Math.min(err.length, 6)) === 3) {
      const wait = tlv.get(Tlv.BackOff);
      throw new PairingBackoffError(
        wait ? wait.readUIntLE(0, Math.min(wait.length, 6)) : 60,
      );
    }
    throw new Error(`Pairing failed: ${describeTlvError(err)}`);
  }
  return tlv;
}

function need(tlv: Map<number, Buffer>, tag: number, label: string): Buffer {
  const v = tlv.get(tag);
  if (!v) throw new Error(`Apple TV response is missing ${label}`);
  return v;
}

/** The Apple TV dismissed the PIN (closed the pairing connection) before we could use it. */
export class PinExpiredError extends Error {
  constructor(public readonly afterSeconds: number) {
    super(
      `The Apple TV closed the pairing request after ${afterSeconds.toFixed(0)}s.`,
    );
  }
}

/** Pair-setup, split in two so the UI can ask for the PIN the TV displays in between. */
export class PairSetup {
  private constructor(
    private session: CompanionSession,
    private salt: Buffer,
    private serverPublic: Buffer,
  ) {}

  /** Connects and asks the Apple TV to display a PIN. */
  static async begin(
    host: string,
    port: number,
    options: { keepalive?: boolean } = {},
  ): Promise<PairSetup> {
    const session = await CompanionSession.connect(host, port);
    try {
      const resp = await session.exchangeAuth(FrameType.PS_Start, {
        _pd: writeTlv([
          [Tlv.Method, Buffer.from([0])],
          [Tlv.SeqNo, Buffer.from([1])],
        ]),
        _pwTy: 1,
      });
      const tlv = pairingData(resp);
      if (options.keepalive) session.startKeepalive(2000);
      return new PairSetup(
        session,
        need(tlv, Tlv.Salt, "salt"),
        need(tlv, Tlv.PublicKey, "public key"),
      );
    } catch (error) {
      session.close();
      throw error;
    }
  }

  private readonly openedAt = Date.now();

  /** Fires if the Apple TV closes the pairing connection (i.e. dismisses the PIN) on its own. */
  set onClose(
    callback: (afterSeconds: number, sinceKeepaliveMs?: number) => void,
  ) {
    this.session.onClose = ({ afterMs, sinceKeepaliveMs }) =>
      callback(afterMs / 1000, sinceKeepaliveMs);
  }

  get isOpen(): boolean {
    return this.session.isOpen;
  }

  cancel() {
    this.session.close();
  }

  async finish(pin: string, clientName: string): Promise<Credentials> {
    if (!this.session.isOpen)
      throw new PinExpiredError((Date.now() - this.openedAt) / 1000);
    this.session.stopKeepalive();
    try {
      const srp = new SrpClient("Pair-Setup", pin);
      const proof = srp.process(this.salt, this.serverPublic);

      const m2Resp = await this.session.exchangeAuth(FrameType.PS_Next, {
        _pd: writeTlv([
          [Tlv.SeqNo, Buffer.from([3])],
          [Tlv.PublicKey, srp.publicKey],
          [Tlv.Proof, proof],
        ]),
        _pwTy: 1,
      });
      const m2 = pairingData(m2Resp);
      if (!srp.verifyServerProof(need(m2, Tlv.Proof, "proof")))
        throw new Error("Apple TV proof did not verify");

      const K = srp.sessionKey;
      const seed = crypto.randomBytes(32);
      const ltpk = ed25519PublicFromSeed(seed);
      const clientId = Buffer.from(crypto.randomUUID().toUpperCase());

      const controllerX = hkdfSha512(
        "Pair-Setup-Controller-Sign-Salt",
        "Pair-Setup-Controller-Sign-Info",
        K,
      );
      const sessionKey = hkdfSha512(
        "Pair-Setup-Encrypt-Salt",
        "Pair-Setup-Encrypt-Info",
        K,
      );
      const signature = ed25519Sign(
        seed,
        Buffer.concat([controllerX, clientId, ltpk]),
      );

      const inner = writeTlv([
        [Tlv.Identifier, clientId],
        [Tlv.PublicKey, ltpk],
        [Tlv.Signature, signature],
        [Tlv.Name, pack({ name: clientName })],
      ]);
      const m5 = chachaEncrypt(sessionKey, labelNonce("PS-Msg05"), inner);
      const m6Resp = await this.session.exchangeAuth(FrameType.PS_Next, {
        _pd: writeTlv([
          [Tlv.SeqNo, Buffer.from([5])],
          [Tlv.EncryptedData, m5],
        ]),
        _pwTy: 1,
      });
      const m6 = pairingData(m6Resp);
      const plain = chachaDecrypt(
        sessionKey,
        labelNonce("PS-Msg06"),
        need(m6, Tlv.EncryptedData, "encrypted data"),
      );
      const device = readTlv(plain);

      return {
        ltpk: need(device, Tlv.PublicKey, "device public key"),
        ltsk: seed,
        atvId: need(device, Tlv.Identifier, "device identifier"),
        clientId,
      };
    } finally {
      this.session.close();
    }
  }
}

/** Pair-verify on an open session, then switch it to encrypted mode. */
export async function pairVerify(
  session: CompanionSession,
  creds: Credentials,
): Promise<void> {
  const ours = x25519Generate();
  const m2Resp = await session.exchangeAuth(FrameType.PV_Start, {
    _pd: writeTlv([
      [Tlv.SeqNo, Buffer.from([1])],
      [Tlv.PublicKey, ours.publicKey],
    ]),
    _auTy: 4,
  });
  const m2 = pairingData(m2Resp);
  const serverPublic = need(m2, Tlv.PublicKey, "public key");
  const encrypted = need(m2, Tlv.EncryptedData, "encrypted data");

  const shared = ours.agree(serverPublic);
  const verifyKey = hkdfSha512(
    "Pair-Verify-Encrypt-Salt",
    "Pair-Verify-Encrypt-Info",
    shared,
  );
  const inner = readTlv(
    chachaDecrypt(verifyKey, labelNonce("PV-Msg02"), encrypted),
  );
  const identifier = need(inner, Tlv.Identifier, "identifier");
  const signature = need(inner, Tlv.Signature, "signature");

  if (!identifier.equals(creds.atvId))
    throw new Error("Connected to an unexpected device");
  if (
    !ed25519Verify(
      creds.ltpk,
      signature,
      Buffer.concat([serverPublic, identifier, ours.publicKey]),
    )
  ) {
    throw new Error("Apple TV signature did not verify");
  }

  const mySignature = ed25519Sign(
    creds.ltsk,
    Buffer.concat([ours.publicKey, creds.clientId, serverPublic]),
  );
  const m3 = chachaEncrypt(
    verifyKey,
    labelNonce("PV-Msg03"),
    writeTlv([
      [Tlv.Identifier, creds.clientId],
      [Tlv.Signature, mySignature],
    ]),
  );
  const m4 = await session.exchangeAuth(FrameType.PV_Next, {
    _pd: writeTlv([
      [Tlv.SeqNo, Buffer.from([3])],
      [Tlv.EncryptedData, m3],
    ]),
  });
  pairingData(m4); // surfaces an error TLV if verification was rejected

  session.enableEncryption(
    hkdfSha512("", "ClientEncrypt-main", shared),
    hkdfSha512("", "ServerEncrypt-main", shared),
  );
}
