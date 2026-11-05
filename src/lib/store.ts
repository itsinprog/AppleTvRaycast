/** Persistence (Raycast's encrypted LocalStorage) plus the glue between UI and the Companion client. */
import { LocalStorage } from "@raycast/api";
import { Button, PairedDevice, pressButtons } from "./companion/client";
import { parseCredentials } from "./companion/pairing";

const KEY = "pairedDevice";

export class NotPairedError extends Error {
  constructor() {
    super("No Apple TV paired yet. Run “Pair Apple TV” first.");
  }
}

export async function loadDevice(): Promise<PairedDevice | undefined> {
  const raw = await LocalStorage.getItem<string>(KEY);
  return raw ? (JSON.parse(raw) as PairedDevice) : undefined;
}

export async function saveDevice(device: PairedDevice): Promise<void> {
  await LocalStorage.setItem(KEY, JSON.stringify(device));
}

export async function clearDevice(): Promise<void> {
  await LocalStorage.removeItem(KEY);
}

/** Sends button taps to the paired Apple TV; remembers a new address if the TV moved. */
export async function sendButtons(...buttons: Button[]): Promise<void> {
  const device = await loadDevice();
  if (!device) throw new NotPairedError();
  const used = await pressButtons(
    device,
    parseCredentials(device.credentials),
    buttons,
  );
  if (used.port !== device.port || used.hostname !== device.hostname) {
    await saveDevice({ ...device, hostname: used.hostname, port: used.port });
  }
}
