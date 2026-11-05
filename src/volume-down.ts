import { runQuick } from "./lib/quick";

export default async function Command() {
  await runQuick("volume_down", "🔉 Volume Down");
}
