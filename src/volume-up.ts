import { runQuick } from "./lib/quick";

export default async function Command() {
  await runQuick("volume_up", "🔊 Volume Up");
}
