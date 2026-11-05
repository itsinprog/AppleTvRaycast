import { runQuick } from "./lib/quick";

export default async function Command() {
  await runQuick("wake", "⏻ Apple TV On");
}
