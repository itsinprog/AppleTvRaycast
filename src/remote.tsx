import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  LaunchType,
  launchCommand,
  Keyboard,
} from "@raycast/api";
import { showFailureToast, usePromise } from "@raycast/utils";
import { useEffect, useRef, useState } from "react";
import { Button, RemoteSession } from "./lib/companion/client";
import { parseCredentials } from "./lib/companion/pairing";
import { loadDevice } from "./lib/store";

/** Buttons that have a lit-up version of the artwork in assets/. */
const LIGHTABLE = new Set<Button>([
  "up",
  "down",
  "left",
  "right",
  "select",
  "menu",
  "home",
  "play_pause",
  "volume_up",
  "volume_down",
]);

type Connection = "connecting" | "connected" | "error";

const STATUS: Record<Connection, { text: string; icon: Icon; color: Color }> = {
  connecting: {
    text: "Connecting…",
    icon: Icon.CircleProgress,
    color: Color.Orange,
  },
  connected: { text: "Connected", icon: Icon.CheckCircle, color: Color.Green },
  error: {
    text: "Not connected, will retry on next key",
    icon: Icon.XMarkCircle,
    color: Color.Red,
  },
};

export default function Command() {
  const { data: device, isLoading } = usePromise(loadDevice);
  const remote = useRef<RemoteSession>();
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lit, setLit] = useState<Button>();
  const litTimer = useRef<NodeJS.Timeout>();

  // One long-lived connection for as long as the view is open: key presses are instant.
  useEffect(() => {
    if (!device) return;
    const session = new RemoteSession(
      device,
      parseCredentials(device.credentials),
    );
    remote.current = session;
    setConnection("connecting");
    session
      .warmUp()
      .then(() => setConnection("connected"))
      .catch(() => setConnection("error"));
    return () => {
      session.close();
      clearTimeout(litTimer.current);
    };
  }, [device]);

  const press = (button: Button) => async () => {
    if (LIGHTABLE.has(button)) {
      setLit(button);
      clearTimeout(litTimer.current);
      litTimer.current = setTimeout(() => setLit(undefined), 220);
    }
    try {
      await remote.current?.tap(button);
      setConnection("connected");
    } catch (error) {
      setConnection("error");
      await showFailureToast(error, { title: "Apple TV command failed" });
    }
  };

  if (!isLoading && !device) {
    return (
      <Detail
        markdown={
          "# No Apple TV paired\n\nPair your Apple TV once and the remote is ready to use."
        }
        actions={
          <ActionPanel>
            <Action
              title="Pair Apple TV"
              icon={Icon.Link}
              onAction={() =>
                launchCommand({ name: "setup", type: LaunchType.UserInitiated })
              }
            />
          </ActionPanel>
        }
      />
    );
  }

  const status = STATUS[connection];

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={device ? `${device.name} Remote` : "Apple TV Remote"}
      markdown={`![Remote](remote-${lit ?? "idle"}.svg?raycast-width=210&raycast-height=403)`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label
            title="Apple TV"
            text={device?.name ?? "…"}
            icon={Icon.Desktop}
          />
          <Detail.Metadata.Label
            title="Status"
            text={status.text}
            icon={{ source: status.icon, tintColor: status.color }}
          />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Navigate" text="W  A  S  D" />
          <Detail.Metadata.Label title="Select" text="↵" />
          <Detail.Metadata.Label title="Back / Menu" text="M" />
          <Detail.Metadata.Label title="Home" text="H" />
          <Detail.Metadata.Label title="Play / Pause" text="P" />
          <Detail.Metadata.Label title="Volume" text="=  /  −" />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Wake / Sleep" text="⌘⇧W  /  ⌘⇧S" />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Navigate">
            <Action
              title="Select"
              icon={Icon.Circle}
              onAction={press("select")}
            />
            <Action
              title="Up"
              icon={Icon.ArrowUp}
              shortcut={{ modifiers: [], key: "w" }}
              onAction={press("up")}
            />
            <Action
              title="Down"
              icon={Icon.ArrowDown}
              shortcut={{ modifiers: [], key: "s" }}
              onAction={press("down")}
            />
            <Action
              title="Left"
              icon={Icon.ArrowLeft}
              shortcut={{ modifiers: [], key: "a" }}
              onAction={press("left")}
            />
            <Action
              title="Right"
              icon={Icon.ArrowRight}
              shortcut={{ modifiers: [], key: "d" }}
              onAction={press("right")}
            />
            <Action
              title="Back / Menu"
              icon={Icon.ChevronLeft}
              shortcut={{ modifiers: [], key: "m" }}
              onAction={press("menu")}
            />
            <Action
              title="Home"
              icon={Icon.Desktop}
              shortcut={{ modifiers: [], key: "h" }}
              onAction={press("home")}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Playback & Volume">
            <Action
              title="Play / Pause"
              icon={Icon.Play}
              shortcut={{ modifiers: [], key: "p" }}
              onAction={press("play_pause")}
            />
            <Action
              title="Volume up"
              icon={Icon.SpeakerHigh}
              shortcut={{ modifiers: [], key: "=" }}
              onAction={press("volume_up")}
            />
            <Action
              title="Volume Down"
              icon={Icon.SpeakerLow}
              shortcut={{ modifiers: [], key: "-" }}
              onAction={press("volume_down")}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Power">
            <Action
              title="Wake Apple TV"
              icon={Icon.Power}
              shortcut={{ modifiers: ["cmd", "shift"], key: "w" }}
              onAction={press("wake")}
            />
            <Action
              title="Sleep Apple TV"
              icon={Icon.Moon}
              shortcut={Keyboard.Shortcut.Common.Duplicate}
              onAction={press("sleep")}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
