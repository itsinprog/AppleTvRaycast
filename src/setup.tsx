import {
  Action,
  ActionPanel,
  Form,
  Icon,
  List,
  Toast,
  popToRoot,
  showToast,
  useNavigation,
  Keyboard,
} from "@raycast/api";
import { showFailureToast, usePromise } from "@raycast/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { CLIENT_NAME, PairedDevice } from "./lib/companion/client";
import {
  DiscoveredDevice,
  discoverAppleTVs,
  resolveHost,
} from "./lib/companion/discovery";
import {
  PairSetup,
  PairingBackoffError,
  PinExpiredError,
  serializeCredentials,
} from "./lib/companion/pairing";
import { LOG_PATH, log } from "./lib/log";
import { clearDevice, loadDevice, saveDevice } from "./lib/store";

/** How many times we silently ask for a fresh PIN when the TV dismisses one. */
const MAX_AUTO_RESTARTS = 1;

/**
 * The Apple TV only shows the PIN while the pairing connection is open, and it may close
 * that connection after a few seconds. So this screen: (1) opens the pairing request the
 * moment it appears, (2) submits automatically at the 4th digit, and (3) if the TV
 * dismisses the PIN first, immediately requests a new one.
 */
function PinForm({ device }: { device: DiscoveredDevice }) {
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState("Contacting your Apple TV…");
  const pairing = useRef<PairSetup>();
  const finishing = useRef(false);
  const mounted = useRef(true);
  const restarts = useRef(0);
  const generation = useRef(0);
  const keepalive = useRef(false); // off: pyatv and other working clients send no keep-alive
  const [wait, setWait] = useState(0); // seconds the TV asked us to wait

  const start = useCallback(
    async (message?: string) => {
      const gen = ++generation.current;
      pairing.current?.cancel();
      pairing.current = undefined;
      finishing.current = false;
      setPin("");
      setStatus(message ?? "Contacting your Apple TV…");
      log(`start #${gen} keepalive=${keepalive.current}`);
      try {
        const ip = await resolveHost(device.hostname);
        const p = await PairSetup.begin(ip, device.port, {
          keepalive: keepalive.current,
        });
        if (gen !== generation.current || !mounted.current) {
          p.cancel(); // superseded while connecting
          return;
        }
        pairing.current = p;
        log(`#${gen} PIN requested; connection open`);
        p.onClose = (seconds, sinceKeepaliveMs) => {
          log(
            `#${gen} TV closed the pairing connection after ${seconds.toFixed(1)}s (since last keep-alive: ${sinceKeepaliveMs ?? "n/a"} ms)`,
          );
          if (
            gen !== generation.current ||
            finishing.current ||
            !mounted.current
          )
            return;
          // If the TV hung up right after a keep-alive, the keep-alive is the problem: stop sending it.
          const blamedKeepalive =
            keepalive.current &&
            sinceKeepaliveMs !== undefined &&
            sinceKeepaliveMs < 1500;
          if (blamedKeepalive) keepalive.current = false;
          if (restarts.current < MAX_AUTO_RESTARTS) {
            restarts.current++;
            start(
              `The TV dismissed the PIN after ${seconds.toFixed(0)}s${blamedKeepalive ? " (retrying without keep-alive)" : ""}. A new one is showing now — type it right away.`,
            );
          } else {
            setStatus(
              `The TV keeps dismissing the PIN (after ~${seconds.toFixed(0)}s). Press ⌘R for a new one and type it quickly.`,
            );
          }
        };
        setStatus(
          `Type the 4-digit PIN showing on “${device.name}”. It submits automatically.`,
        );
      } catch (error) {
        log(
          `#${gen} begin failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (error instanceof PairingBackoffError) {
          // Do NOT retry: every attempt extends the TV's back-off. Count down, then try once.
          restarts.current = MAX_AUTO_RESTARTS;
          setWait(error.seconds);
          return;
        }
        setStatus("Could not reach the Apple TV. Press ⌘R to try again.");
        await showFailureToast(error, { title: "Could not start pairing" });
      }
    },
    [device],
  );

  const started = useRef(false);
  useEffect(() => {
    mounted.current = true;
    // Only ever open ONE pairing request per screen (a dev-mode double mount must not open two:
    // the second would make the TV drop the first PIN, and repeated attempts trigger back-off).
    if (!started.current) {
      started.current = true;
      start();
    }
    return () => {
      mounted.current = false;
      const current = pairing.current;
      // Deferred so a development-mode remount doesn't kill the pairing request.
      setTimeout(() => {
        if (!mounted.current) current?.cancel();
      }, 300);
    };
  }, [start]);

  // Respect the TV's back-off: wait it out without touching the TV, then try once.
  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => {
      if (wait === 1) start("Trying again…");
      setWait(wait - 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [wait, start]);

  async function submit(value: string) {
    const p = pairing.current;
    if (!p || finishing.current || value.length !== 4) return;
    finishing.current = true;
    setStatus("Pairing…");
    try {
      const creds = await p.finish(value, CLIENT_NAME);
      const paired: PairedDevice = {
        ...device,
        credentials: serializeCredentials(creds),
      };
      await saveDevice(paired);
      await showToast({
        style: Toast.Style.Success,
        title: `Paired with ${device.name}`,
        message: "Open the Remote command to use it.",
      });
      await popToRoot();
    } catch (error) {
      const expired = error instanceof PinExpiredError;
      log(
        `submit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (error instanceof PairingBackoffError) {
        setWait(error.seconds);
        return;
      }
      if (!expired) await showFailureToast(error, { title: "Pairing failed" });
      // A PIN attempt is single-use, so always start over with a fresh one.
      start(
        expired
          ? `The TV dismissed the PIN after ${error.afterSeconds.toFixed(0)}s. A new one is showing now.`
          : "That didn't work. A new PIN is showing now.",
      );
    }
  }

  function onChange(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 4);
    setPin(digits);
    if (digits.length === 4) submit(digits);
  }

  return (
    <Form
      navigationTitle={`Pair with ${device.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Pair" onSubmit={() => submit(pin)} />
          <Action.ShowInFinder
            title="Show Pairing Log"
            path={LOG_PATH}
            shortcut={{ modifiers: ["cmd"], key: "l" }}
          />
          <Action
            title="Show a New PIN"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={() => {
              if (wait > 0) return; // the TV asked us to wait
              restarts.current = 0;
              start("Requesting a new PIN…");
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Status"
        text={
          wait > 0
            ? `The Apple TV is rate-limiting pairing after too many attempts. Waiting ${wait}s before one more try. Don't retry sooner: it only extends the wait.`
            : status
        }
      />
      <Form.TextField
        id="pin"
        title="PIN"
        placeholder="1234"
        value={pin}
        onChange={onChange}
        autoFocus
      />
    </Form>
  );
}

export default function Command() {
  const { push } = useNavigation();
  const discovery = usePromise(() => discoverAppleTVs(3500));
  const paired = usePromise(loadDevice);

  return (
    <List
      isLoading={discovery.isLoading || paired.isLoading}
      searchBarPlaceholder="Choose your Apple TV"
    >
      {paired.data && (
        <List.Section title="Currently Paired">
          <List.Item
            icon={Icon.CheckCircle}
            title={paired.data.name}
            subtitle={paired.data.model}
            actions={
              <ActionPanel>
                <Action
                  title="Forget This Apple TV"
                  style={Action.Style.Destructive}
                  icon={Icon.Trash}
                  onAction={async () => {
                    await clearDevice();
                    await paired.revalidate();
                  }}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
      <List.Section title="Found on Your Network">
        {(discovery.data ?? []).map((d) => (
          <List.Item
            key={d.deviceId || d.name}
            icon={Icon.Desktop}
            title={d.name}
            subtitle={d.model}
            actions={
              <ActionPanel>
                <Action
                  title="Pair"
                  icon={Icon.Link}
                  onAction={() => push(<PinForm device={d} />)}
                />
                <Action
                  title="Rescan"
                  icon={Icon.ArrowClockwise}
                  onAction={() => discovery.revalidate()}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      {!discovery.isLoading && (discovery.data ?? []).length === 0 && (
        <List.EmptyView
          title="No Apple TV found"
          description="Make sure it is awake and on the same network, then rescan."
          actions={
            <ActionPanel>
              <Action
                title="Rescan"
                icon={Icon.ArrowClockwise}
                onAction={() => discovery.revalidate()}
              />
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}
