/** High-level API: connect to a paired Apple TV and press remote buttons. */
import { OpackFloat } from "./opack";
import { Credentials, pairVerify } from "./pairing";
import { CompanionSession } from "./session";
import { DiscoveredDevice, discoverDevices, resolveHost } from "./discovery";

export const BUTTONS = {
  up: 1,
  down: 2,
  left: 3,
  right: 4,
  menu: 5,
  select: 6,
  home: 7,
  volume_up: 8,
  volume_down: 9,
  siri: 10,
  screensaver: 11,
  sleep: 12,
  wake: 13,
  play_pause: 14,
  channel_up: 15,
  channel_down: 16,
  guide: 17,
  page_up: 18,
  page_down: 19,
} as const;
export type Button = keyof typeof BUTTONS;

/** What we persist about a paired Apple TV. */
export interface PairedDevice extends DiscoveredDevice {
  credentials: string;
}

export const CLIENT_NAME = "Raycast";

/**
 * Opens an authenticated session. Only pair-verify needs real round trips: the init
 * messages are pipelined (sent back-to-back, replies collected later) via the returned
 * `ready` promise, which resolves once the Apple TV has acknowledged all of them.
 */
async function openSession(
  host: string,
  port: number,
  creds: Credentials,
  device: DiscoveredDevice,
) {
  const session = await CompanionSession.connect(host, port);
  try {
    await pairVerify(session, creds);
    const init = [
      session.request("_systemInfo", {
        _bf: 0,
        _cf: 512,
        _clFl: 128,
        _i: device.deviceId.replace(/:/g, "").toLowerCase() || "raycastremote",
        _idsID: creds.clientId,
        _pubID: device.deviceId,
        _sf: 256,
        _sv: "170.18",
        model: "iPhone10,6",
        name: CLIENT_NAME,
      }),
      session.request("_touchStart", {
        _height: new OpackFloat(1000),
        _tFl: 0,
        _width: new OpackFloat(1000),
      }),
      session.request("_sessionStart", {
        _srvT: "com.apple.tvremoteservices",
        _sid: Math.floor(Math.random() * 0xffffffff),
      }),
    ];
    return { session, init };
  } catch (error) {
    session.close();
    throw error;
  }
}

/** Connects using the stored address, re-discovering the device if the stored one has moved. */
export async function connectToDevice(
  device: DiscoveredDevice,
  creds: Credentials,
) {
  try {
    const ip = await resolveHost(device.hostname);
    return { ...(await openSession(ip, device.port, creds, device)), device };
  } catch (firstError) {
    // The port (or address) may have changed since pairing. Look the device up again.
    const found = await discoverDevices(4000, (list) =>
      list.some((d) => matches(d, device)),
    );
    const fresh = found.find((d) => matches(d, device));
    if (
      !fresh ||
      (fresh.port === device.port && fresh.hostname === device.hostname)
    )
      throw firstError;
    const ip = await resolveHost(fresh.hostname);
    return {
      ...(await openSession(ip, fresh.port, creds, fresh)),
      device: fresh,
    };
  }
}

function matches(a: DiscoveredDevice, b: DiscoveredDevice): boolean {
  return a.deviceId && b.deviceId
    ? a.deviceId === b.deviceId
    : a.name === b.name;
}

/** Queues a button press without waiting; the returned promises settle when the TV acknowledges. */
function queuePress(
  session: CompanionSession,
  button: Button,
): Promise<unknown>[] {
  const code = BUTTONS[button];
  const calls: Promise<unknown>[] = [];
  // sleep/wake are "button up" only; everything else is a tap (down, then up).
  if (button !== "sleep" && button !== "wake")
    calls.push(session.request("_hidC", { _hBtS: 1, _hidC: code }));
  calls.push(session.request("_hidC", { _hBtS: 2, _hidC: code }));
  return calls;
}

/**
 * Sends one or more button taps over a single connection. Returns the (possibly
 * re-discovered) device so callers can persist an updated address.
 */
export async function pressButtons(
  device: DiscoveredDevice,
  creds: Credentials,
  buttons: Button[],
): Promise<DiscoveredDevice> {
  const { session, init, device: used } = await connectToDevice(device, creds);
  try {
    const calls = [...init, ...buttons.flatMap((b) => queuePress(session, b))];
    await Promise.all(calls);
  } finally {
    session.close();
  }
  return used;
}

/**
 * A long-lived connection for interactive use (the Remote view): connects once, then every
 * tap is instant. Reconnects transparently if the Apple TV dropped the idle connection.
 */
export class RemoteSession {
  private current?: Awaited<ReturnType<typeof connectToDevice>>;
  private connecting?: Promise<Awaited<ReturnType<typeof connectToDevice>>>;
  private closed = false;

  constructor(
    private device: DiscoveredDevice,
    private creds: Credentials,
  ) {}

  private ensure() {
    if (this.current?.session.isOpen) return Promise.resolve(this.current);
    this.connecting ??= connectToDevice(this.device, this.creds)
      .then((c) => {
        c.init.forEach((p) => p.catch(() => undefined)); // errors surface through tap()/warmUp()
        if (this.closed) c.session.close();
        this.current = c;
        this.device = c.device;
        return c;
      })
      .finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  /** Connects ahead of the first key press. */
  async warmUp(): Promise<void> {
    const c = await this.ensure();
    await Promise.all(c.init);
  }

  async tap(button: Button): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await this.ensure();
        await Promise.all([...c.init, ...queuePress(c.session, button)]);
        return;
      } catch (error) {
        this.current?.session.close();
        this.current = undefined;
        if (attempt >= 1 || this.closed) throw error;
      }
    }
  }

  close() {
    this.closed = true;
    this.current?.session.close();
    this.current = undefined;
  }
}
