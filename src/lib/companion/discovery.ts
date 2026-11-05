/**
 * Finds Apple TVs using macOS's built-in `dns-sd` (goes through mDNSResponder, so it
 * works without the Local Network permission dance raw multicast sockets need).
 */
import { spawn } from "node:child_process";
import dns from "node:dns";

export interface DiscoveredDevice {
  /** Bonjour instance name, e.g. "Living Room". */
  name: string;
  /** mDNS hostname, e.g. "Living-Room.local". Resolved to an IP at connect time. */
  hostname: string;
  port: number;
  /** e.g. "AppleTV14,1". */
  model: string;
  /** Bluetooth/device address from the `rpBA` TXT record; stable across IP changes. */
  deviceId: string;
}

function unescapeDnsName(s: string): string {
  return s
    .replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\\(.)/g, "$1");
}

export function parseZone(output: string): DiscoveredDevice[] {
  const srv = new Map<string, { port: number; hostname: string }>();
  const txt = new Map<string, Record<string, string>>();

  for (const line of output.split("\n")) {
    const s = line.match(
      /^(.+?)\._companion-link\._tcp\s+SRV\s+\d+\s+\d+\s+(\d+)\s+(\S+)/,
    );
    if (s) {
      srv.set(unescapeDnsName(s[1]), {
        port: Number(s[2]),
        hostname: s[3].replace(/\.$/, ""),
      });
      continue;
    }
    const t = line.match(/^(.+?)\._companion-link\._tcp\s+TXT\s+(.*)$/);
    if (t) {
      const props: Record<string, string> = {};
      for (const m of t[2].matchAll(/"([^"]*)"/g)) {
        const i = m[1].indexOf("=");
        if (i > 0) props[m[1].slice(0, i)] = m[1].slice(i + 1);
      }
      txt.set(unescapeDnsName(t[1]), props);
    }
  }

  const devices: DiscoveredDevice[] = [];
  for (const [name, { port, hostname }] of srv) {
    const props = txt.get(name) ?? {};
    devices.push({
      name,
      hostname,
      port,
      model: props["rpMd"] ?? "",
      deviceId: props["rpBA"] ?? "",
    });
  }
  return devices;
}

/** Browses for companion-link services for `durationMs`, optionally stopping early once `stopWhen` matches. */
export function discoverDevices(
  durationMs = 3000,
  stopWhen?: (devices: DiscoveredDevice[]) => boolean,
): Promise<DiscoveredDevice[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/dns-sd", [
      "-Z",
      "_companion-link._tcp",
      "local.",
    ]);
    let out = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      child.kill();
      resolve(parseZone(out));
    };
    const timer = setTimeout(finish, durationMs);
    const poll = setInterval(() => {
      if (stopWhen && stopWhen(parseZone(out))) finish();
    }, 250);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      clearInterval(poll);
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

export async function discoverAppleTVs(
  durationMs = 3000,
): Promise<DiscoveredDevice[]> {
  const all = await discoverDevices(durationMs);
  return all
    .filter((d) => d.model.startsWith("AppleTV"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolves a .local hostname (or passes through an IP) to an IPv4 address. */
export function resolveHost(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { family: 4 }, (err, address) =>
      err ? reject(err) : resolve(address),
    );
  });
}
