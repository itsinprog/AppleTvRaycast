/** Tiny file logger so pairing problems can be diagnosed after the fact (Raycast hides console output). */
import { environment } from "@raycast/api";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const LOG_PATH = join(environment.supportPath, "pairing.log");

export function log(message: string): void {
  try {
    mkdirSync(environment.supportPath, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never break the UI
  }
}
