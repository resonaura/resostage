import { useEffect, useState } from "react";
import { Card } from "@heroui/react";
import { settings as settingsApi } from "../lib/api";
import type { WebUiState } from "../lib/types";

function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-default/30 p-3">
      <div className="text-[11px] uppercase tracking-wide text-foreground/50">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const selectCls =
  "w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-sm outline-none focus:border-accent";
const labelCls = "text-[11px] font-semibold uppercase tracking-wide text-foreground/50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

// Best-effort mirror of juce::KeyPress::getTextDescription()'s format
// ("cmd + p", "space", "escape", ...) -- covers the common single-key and
// simple-modifier-combo rebinds; exotic combos may need a manual nudge.
function keyEventToDescription(e: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null; // wait for a real key
  if (e.key === "Escape") return "__cancel__";

  const parts: string[] = [];
  if (e.metaKey) parts.push("cmd");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");

  const named: Record<string, string> = {
    " ": "space",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Enter: "return",
    Tab: "tab",
    Backspace: "backspace",
    Delete: "delete",
  };
  let key = named[e.key] ?? (e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
  if (/^f\d{1,2}$/.test(key)) key = key; // function keys already lowercase e.g. "f1"

  parts.push(key);
  return parts.join(" + ");
}

function KeybindingRow({ action, current }: { action: string; current: string }) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      const desc = keyEventToDescription(e);
      setListening(false);
      if (desc && desc !== "__cancel__") void settingsApi.setKeybinding(action, desc);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [listening, action]);

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-default/10 px-3 py-2">
      <span className="text-sm capitalize">{action}</span>
      <button
        onClick={() => setListening(true)}
        className={`rounded-lg border px-3 py-1 text-sm ${
          listening
            ? "border-accent bg-accent/10 text-accent"
            : "border-default/60 bg-default/20 hover:bg-default/30"
        }`}
      >
        {listening ? "Press a key… (Esc cancels)" : current || "(unbound)"}
      </button>
    </div>
  );
}

export function SettingsScreen({ state }: { state: WebUiState }) {
  const h = state.health;
  const s = state.settings;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Card>
        <Card.Header>
          <Card.Title>Audio device</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <Field label="Output device">
            <select
              className={selectCls}
              value={s.currentOutputDevice}
              onChange={(e) => void settingsApi.setAudioOutputDevice(e.target.value)}
            >
              {s.currentOutputDevice && !s.outputDevices.includes(s.currentOutputDevice) && (
                <option value={s.currentOutputDevice}>{s.currentOutputDevice}</option>
              )}
              {s.outputDevices.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sample rate">
              <select
                className={selectCls}
                value={s.sampleRate}
                onChange={(e) => void settingsApi.setSampleRate(Number(e.target.value))}
              >
                {s.availableSampleRates.map((r) => (
                  <option key={r} value={r}>
                    {r.toLocaleString()} Hz
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Buffer size">
              <select
                className={selectCls}
                value={s.bufferSize}
                onChange={(e) => void settingsApi.setBufferSize(Number(e.target.value))}
              >
                {s.availableBufferSizes.map((b) => (
                  <option key={b} value={b}>
                    {b} samples
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {s.outputChannelNames.length > 0 && (
            <Field label="Active output channels">
              <div className="flex flex-wrap gap-1.5">
                {s.outputChannelNames.map((name, i) => {
                  const active = s.activeOutputChannels[i] ?? false;
                  return (
                    <button
                      key={i}
                      onClick={() => {
                        const activeIndices = s.outputChannelNames
                          .map((_, idx) => idx)
                          .filter((idx) => (idx === i ? !active : (s.activeOutputChannels[idx] ?? false)));
                        void settingsApi.setOutputChannels(activeIndices);
                      }}
                      className={`rounded-lg border px-3 py-1.5 text-sm ${
                        active
                          ? "border-accent bg-accent/15 text-accent"
                          : "border-default/60 bg-default/10 text-foreground/50 hover:bg-default/20"
                      }`}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>MIDI</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <Field label="MIDI output (Live Stage / hardware)">
            <select
              className={selectCls}
              defaultValue=""
              onChange={(e) => e.target.value && void settingsApi.setMidiOutput(e.target.value)}
            >
              <option value="" disabled>
                Select MIDI output…
              </option>
              {s.midiOutputs.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="MIDI remote input (footswitch / pads)">
            <select
              className={selectCls}
              defaultValue=""
              onChange={(e) => e.target.value && void settingsApi.setMidiInput(e.target.value)}
            >
              <option value="" disabled>
                Select MIDI remote…
              </option>
              {s.midiInputs.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Keyboard shortcuts</Card.Title>
          <Card.Description>Click a binding, then press a key (Esc cancels)</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-1.5">
          {s.keybindings.map((kb) => (
            <KeybindingRow key={kb.action} action={kb.action} current={kb.key} />
          ))}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>System health</Card.Title>
        </Card.Header>
        <Card.Content className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="CPU" value={`${h.cpuPercent.toFixed(1)} %`} />
          <Stat label="RAM (RSS)" value={formatBytes(h.rssBytes)} />
          <Stat label="Free RAM" value={formatBytes(h.freeBytes)} />
          <Stat label="Underruns" value={String(h.underrunCount)} />
          <Stat label="Audio callbacks" value={String(h.audioCallbackCount)} />
          <Stat label="Web clients" value={String(h.webClientCount)} />
        </Card.Content>
      </Card>
    </div>
  );
}
