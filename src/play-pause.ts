import { runQuick } from "./lib/quick";

export default async function Command() {
  await runQuick("play_pause", "⏯ Play/Pause");
}
