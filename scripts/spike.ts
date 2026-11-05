// Standalone CLI to exercise the native Companion implementation against a real Apple TV.
//   npx tsx scripts/spike.ts discover
//   npx tsx scripts/spike.ts pair [name]       (prompts for the PIN shown on the TV)
//   npx tsx scripts/spike.ts press up select   (uses the saved pairing)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { BUTTONS, Button, CLIENT_NAME, PairedDevice, pressButtons } from "../src/lib/companion/client";
import { discoverAppleTVs } from "../src/lib/companion/discovery";
import { PairSetup, parseCredentials, serializeCredentials } from "../src/lib/companion/pairing";
import { resolveHost } from "../src/lib/companion/discovery";

const STORE = path.join(os.homedir(), ".appletv-spike.json");

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "discover") {
    console.log(await discoverAppleTVs());
    return;
  }

  if (cmd === "pair") {
    const devices = await discoverAppleTVs();
    if (devices.length === 0) throw new Error("No Apple TVs found");
    const device = args[0] ? devices.find((d) => d.name.toLowerCase() === args[0].toLowerCase()) : devices[0];
    if (!device) throw new Error(`No Apple TV named "${args[0]}". Found: ${devices.map((d) => d.name).join(", ")}`);
    console.log(`Pairing with ${device.name} (${device.hostname}:${device.port})...`);
    const ip = await resolveHost(device.hostname);
    const pairing = await PairSetup.begin(ip, device.port);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const pin = (await rl.question("Enter the 4-digit PIN shown on your TV: ")).trim();
    rl.close();
    const creds = await pairing.finish(pin, CLIENT_NAME);
    const paired: PairedDevice = { ...device, credentials: serializeCredentials(creds) };
    fs.writeFileSync(STORE, JSON.stringify(paired, null, 2), { mode: 0o600 });
    console.log(`Paired! Saved to ${STORE}`);
    return;
  }

  if (cmd === "press") {
    const paired = JSON.parse(fs.readFileSync(STORE, "utf8")) as PairedDevice;
    const buttons = args as Button[];
    for (const b of buttons) if (!(b in BUTTONS)) throw new Error(`Unknown button: ${b}`);
    const t0 = Date.now();
    await pressButtons(paired, parseCredentials(paired.credentials), buttons);
    console.log(`Sent ${buttons.join(" ")} in ${Date.now() - t0} ms`);
    return;
  }

  console.log("Usage: spike.ts discover | pair [name] | press <button...>");
  console.log("Buttons:", Object.keys(BUTTONS).join(", "));
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
