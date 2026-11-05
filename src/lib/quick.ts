import { LaunchType, launchCommand, showHUD } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { Button } from "./companion/client";
import { NotPairedError, sendButtons } from "./store";

/** Shared body for the no-view commands: send one button, confirm with a HUD. */
export async function runQuick(button: Button, hud: string) {
  try {
    await sendButtons(button);
    await showHUD(hud);
  } catch (error) {
    if (error instanceof NotPairedError) {
      await showHUD("Pair your Apple TV first");
      await launchCommand({ name: "setup", type: LaunchType.UserInitiated });
      return;
    }
    await showFailureToast(error, { title: "Apple TV command failed" });
  }
}
