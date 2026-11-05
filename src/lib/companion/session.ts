/** Framed, optionally encrypted TCP transport plus request/response matching for Companion. */
import net from "node:net";
import { chachaDecrypt, chachaEncrypt, counterNonce } from "./hap";
import { OpackValue, pack, unpack } from "./opack";

export enum FrameType {
  NoOp = 1,
  PS_Start = 3,
  PS_Next = 4,
  PV_Start = 5,
  PV_Next = 6,
  U_OPACK = 7,
  E_OPACK = 8,
  P_OPACK = 9,
}

const AUTH_FRAMES = new Set([
  FrameType.PS_Start,
  FrameType.PS_Next,
  FrameType.PV_Start,
  FrameType.PV_Next,
]);
const OPACK_FRAMES = new Set([
  FrameType.U_OPACK,
  FrameType.E_OPACK,
  FrameType.P_OPACK,
]);
const HEADER_LENGTH = 4;
const TAG_LENGTH = 16;

export type OpackDict = { [key: string]: OpackValue };

interface Pending {
  resolve: (value: OpackDict) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CompanionSession {
  private socket!: net.Socket;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, Pending>();
  private outKey?: Buffer;
  private inKey?: Buffer;
  private outCounter = 0;
  private inCounter = 0;
  private xid = Math.floor(Math.random() * 0x10000);
  private closed = false;
  private closeError?: Error;
  private readonly openedAt = Date.now();

  /** Called once if the Apple TV (not us) closes the connection. */
  onClose?: (info: { afterMs: number; sinceKeepaliveMs?: number }) => void;

  private keepaliveTimer?: NodeJS.Timeout;
  private lastKeepaliveAt?: number;

  /** Sends empty NoOp frames so the Apple TV sees the connection as alive while we wait on the user. */
  startKeepalive(intervalMs: number) {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (!this.isOpen) return this.stopKeepalive();
      this.lastKeepaliveAt = Date.now();
      try {
        this.send(FrameType.NoOp, Buffer.alloc(0));
      } catch {
        this.stopKeepalive();
      }
    }, intervalMs);
  }

  stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  get isOpen(): boolean {
    return !this.closed && !this.closeError && !this.socket.destroyed;
  }

  static connect(
    host: string,
    port: number,
    timeoutMs = 5000,
  ): Promise<CompanionSession> {
    return new Promise((resolve, reject) => {
      const session = new CompanionSession();
      const socket = net.connect({ host, port });
      session.socket = socket;
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to ${host}:${port}`));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(session);
      });
      socket.on("data", (chunk) => session.onData(chunk));
      socket.on("error", (err) => {
        clearTimeout(timer);
        session.fail(err);
        reject(err);
      });
      socket.on("close", () => {
        if (!session.closed) {
          session.closed = true;
          session.fail(new Error("Connection closed by Apple TV"));
          session.onClose?.({
            afterMs: Date.now() - session.openedAt,
            sinceKeepaliveMs: session.lastKeepaliveAt
              ? Date.now() - session.lastKeepaliveAt
              : undefined,
          });
        }
      });
    });
  }

  enableEncryption(outKey: Buffer, inKey: Buffer) {
    this.outKey = outKey;
    this.inKey = inKey;
  }

  close() {
    this.closed = true;
    this.socket.destroy();
    this.fail(new Error("Session closed"));
  }

  private fail(error: Error) {
    this.stopKeepalive();
    this.closeError ??= error;
    for (const [key, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
      this.pending.delete(key);
    }
  }

  private send(type: FrameType, payload: Buffer) {
    if (this.closed || this.socket.destroyed)
      throw this.closeError ?? new Error("Not connected");
    const encrypt = this.outKey !== undefined && payload.length > 0;
    const length = payload.length + (encrypt ? TAG_LENGTH : 0);
    const header = Buffer.from([
      type,
      (length >> 16) & 0xff,
      (length >> 8) & 0xff,
      length & 0xff,
    ]);
    const body = encrypt
      ? chachaEncrypt(
          this.outKey!,
          counterNonce(this.outCounter++),
          payload,
          header,
        )
      : payload;
    this.socket.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= HEADER_LENGTH) {
      const length =
        (this.buffer[1] << 16) | (this.buffer[2] << 8) | this.buffer[3];
      if (this.buffer.length < HEADER_LENGTH + length) return;
      const header = this.buffer.subarray(0, HEADER_LENGTH);
      let payload = this.buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + length);
      this.buffer = this.buffer.subarray(HEADER_LENGTH + length);
      try {
        if (this.inKey && payload.length > 0) {
          payload = chachaDecrypt(
            this.inKey,
            counterNonce(this.inCounter++),
            payload,
            header,
          );
        }
        this.onFrame(header[0] as FrameType, payload);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        this.socket.destroy();
        return;
      }
    }
  }

  private onFrame(type: FrameType, payload: Buffer) {
    if (!AUTH_FRAMES.has(type) && !OPACK_FRAMES.has(type)) return;
    if (payload.length === 0) return;
    const message = unpack(payload);
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message) ||
      Buffer.isBuffer(message)
    )
      return;
    const dict = message as OpackDict;

    let key: string;
    if (AUTH_FRAMES.has(type)) {
      key = `frame:${type}`;
    } else {
      if (dict["_t"] !== 3) return; // only responses are matched; events are ignored
      key = `xid:${dict["_x"]}`;
    }
    const p = this.pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(key);
    p.resolve(dict);
  }

  private exchange(
    type: FrameType,
    key: string,
    data: OpackDict,
    timeoutMs: number,
  ): Promise<OpackDict> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error("Timed out waiting for Apple TV response"));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      try {
        this.send(type, pack(data));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Pair-setup / pair-verify exchange. The *_Start request is answered by a *_Next frame. */
  exchangeAuth(
    type: FrameType,
    data: OpackDict,
    timeoutMs = 8000,
  ): Promise<OpackDict> {
    const responseType =
      type === FrameType.PS_Start
        ? FrameType.PS_Next
        : type === FrameType.PV_Start
          ? FrameType.PV_Next
          : type;
    return this.exchange(
      type,
      `frame:${responseType}`,
      { ...data, _x: this.xid++ },
      timeoutMs,
    );
  }

  /** Sends an encrypted OPACK request and returns the response's `_c` content. */
  async request(
    identifier: string,
    content: OpackDict,
    timeoutMs = 5000,
  ): Promise<OpackDict> {
    const xid = this.xid++;
    const response = await this.exchange(
      FrameType.E_OPACK,
      `xid:${xid}`,
      { _i: identifier, _t: 2, _c: content, _x: xid },
      timeoutMs,
    );
    if ("_em" in response)
      throw new Error(
        `Apple TV rejected ${identifier}: ${String(response["_em"])}`,
      );
    const c = response["_c"];
    return typeof c === "object" &&
      c !== null &&
      !Array.isArray(c) &&
      !Buffer.isBuffer(c)
      ? (c as OpackDict)
      : {};
  }
}
