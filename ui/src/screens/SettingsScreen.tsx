import { Card } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { settings as settingsApi } from "../lib/api";
import type { MidiBindingRow, WebUiState } from "../lib/types";

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
      <div className="text-[11px] uppercase tracking-wide text-foreground/50">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const selectCls =
  "w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-sm outline-none focus:border-accent";
const labelCls =
  "text-[11px] font-semibold uppercase tracking-wide text-foreground/50";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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
export function keyEventToDescription(e: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null; // wait for a real key
  if (
    e.key === "Escape" &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey
  )
    return "__cancel__";

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
    Home: "home",
    End: "end",
    PageUp: "page up",
    PageDown: "page down",
    Escape: "escape",
  };
  let key =
    named[e.key] ??
    (e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
  if (/^f\d{1,2}$/.test(key)) key = key; // function keys already lowercase e.g. "f1"

  parts.push(key);
  return parts.join(" + ");
}

/** Human labels for the action catalogue (transport / mode / sections). */
const ACTION_LABELS: Record<string, string> = {
  play: "Play / Pause",
  stop: "Stop (pause in place)",
  stop_to_start: "Full stop (return to start)",
  next: "Next song",
  prev: "Previous song",
  mode_player: "Mode: Player",
  mode_mixer: "Mode: Mixer",
  mode_editor: "Mode: Editor",
  mode_settings: "Mode: Settings",
  section_prev: "Previous section",
  section_next: "Next section",
  section_last: "Last section",
  undo: "Undo (timeline)",
  redo: "Redo (timeline)",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

function formatMidi(mb: MidiBindingRow | undefined): string {
  if (!mb || !mb.trigger) return "(unbound)";
  const ch = mb.channel > 0 ? `ch${mb.channel} ` : "any ";
  if (mb.trigger === "cc") return `${ch}CC ${mb.number}`;
  return `${ch}note ${mb.number}`;
}

function BindingRow({
  action,
  currentKey,
  midi,
  learning,
  dotVisible,
  dotDelay,
}: {
  action: string;
  currentKey: string;
  midi?: MidiBindingRow;
  learning: boolean;
  dotVisible: boolean;
  dotDelay?: number;
}) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const desc = keyEventToDescription(e);
      setListening(false);
      if (desc && desc !== "__cancel__")
        void settingsApi.setKeybinding(action, desc);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [listening, action]);

  const midiBound = Boolean(midi?.trigger);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-default/10 px-3 py-2">
      <div className="flex items-center gap-2">
        <div
          className={`h-2 w-2 rounded-full bg-accent transition-all duration-300 ${
            dotVisible ? "scale-100 opacity-100" : "scale-0 opacity-0"
          }`}
          style={dotDelay != null ? { transitionDelay: `${dotDelay}ms` } : undefined}
        />
        <span className="min-w-[10rem] text-sm">{actionLabel(action)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setListening(true)}
          className={`rounded-lg border px-3 py-1 text-sm tabular-nums ${
            listening
              ? "border-accent bg-accent/10 text-accent"
              : "border-default/60 bg-default/20 hover:bg-default/30"
          }`}
          title="Click, then press a key (Esc cancels)"
        >
          {listening ? "Press a key…" : currentKey || "(unbound)"}
        </button>
        <button
          onClick={() => {
            if (learning) void settingsApi.midiLearnCancel();
            else void settingsApi.midiLearn(action);
          }}
          className={`rounded-lg border px-3 py-1 text-sm ${
            learning
              ? "border-accent bg-accent/10 text-accent"
              : "border-default/60 bg-default/20 hover:bg-default/30"
          }`}
          title="Arm MIDI learn — press a pad or CC on the remote input"
        >
          {learning ? "Listening MIDI…" : formatMidi(midi)}
        </button>
        {midiBound && !learning && (
          <button
            onClick={() => void settingsApi.midiClear(action)}
            className="rounded-lg border border-default/40 px-2 py-1 text-xs text-foreground/60 hover:bg-default/20"
            title="Clear MIDI binding"
          >
            Clear MIDI
          </button>
        )}
      </div>
    </div>
  );
}

const ACTION_GROUPS: { title: string; actions: string[] }[] = [
  {
    title: "Transport",
    actions: ["play", "stop", "stop_to_start", "next", "prev"],
  },
  {
    title: "Modes",
    actions: ["mode_player", "mode_mixer", "mode_editor", "mode_settings"],
  },
  {
    title: "Song sections",
    actions: ["section_prev", "section_next", "section_last"],
  },
  {
    title: "Timeline",
    actions: ["undo", "redo"],
  },
];

export function SettingsScreen({ state }: { state: WebUiState }) {
  const h = state.health;
  const s = state.settings;
  const keyByAction = new Map(s.keybindings.map((kb) => [kb.action, kb.key]));
  const midiByAction = new Map(
    (s.midiBindings ?? []).map((mb) => [mb.action, mb]),
  );
  const learningAction = s.midiLearnAction ?? "";

  // Key-press indicator: briefly shows accent dots next to every binding.
  // Uses keyStrokeNonce from the C++ side (MacKeyMonitor / keyPressed)
  // since WKWebView swallows JS keydown events.
  const [dotVisible, setDotVisible] = useState(false);
  const dotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setDotVisible(true);
    if (dotTimer.current) clearTimeout(dotTimer.current);
    dotTimer.current = setTimeout(() => setDotVisible(false), 800);
  }, [state.keyStrokeNonce]);

  // Flat list for staggered dot delays
  const allDotActions = [
    ...ACTION_GROUPS.flatMap(g => g.actions),
    ...s.keybindings
      .filter(kb => !ACTION_GROUPS.some(g => g.actions.includes(kb.action)))
      .map(kb => kb.action),
  ];
  const dotDelayFor = (action: string) => {
    const idx = allDotActions.indexOf(action);
    return idx >= 0 ? idx * 25 : 0;
  };

  const outputDevices =
    s.outputDevices.length > 0
      ? s.outputDevices
      : s.currentOutputDevice
        ? [s.currentOutputDevice]
        : [];
  const sampleRates =
    s.availableSampleRates.length > 0
      ? s.availableSampleRates
      : s.sampleRate > 0
        ? [s.sampleRate]
        : [];
  const bufferSizes =
    s.availableBufferSizes.length > 0
      ? s.availableBufferSizes
      : s.bufferSize > 0
        ? [s.bufferSize]
        : [];

  const devicesEmpty =
    outputDevices.length === 0 &&
    sampleRates.length === 0 &&
    (s.midiOutputs?.length ?? 0) === 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {devicesEmpty && (
        <Card>
          <Card.Content className="py-3 text-sm text-warning">
            Waiting for audio/MIDI device list from the app… If this stays
            empty, restart ResoStage (the native backend on :2899 must be
            running).
          </Card.Content>
        </Card>
      )}
      <Card>
        <Card.Header>
          <Card.Title>Audio device</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <Field label="Output device">
            <select
              className={selectCls}
              value={s.currentOutputDevice || outputDevices[0] || ""}
              onChange={(e) =>
                void settingsApi.setAudioOutputDevice(e.target.value)
              }
            >
              {outputDevices.length === 0 && (
                <option value="">No devices reported</option>
              )}
              {s.currentOutputDevice &&
                !outputDevices.includes(s.currentOutputDevice) && (
                  <option value={s.currentOutputDevice}>
                    {s.currentOutputDevice}
                  </option>
                )}
              {outputDevices.map((d) => (
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
                value={s.sampleRate || sampleRates[0] || ""}
                onChange={(e) =>
                  void settingsApi.setSampleRate(Number(e.target.value))
                }
              >
                {sampleRates.length === 0 && <option value="">—</option>}
                {sampleRates.map((r) => (
                  <option key={r} value={r}>
                    {r.toLocaleString()} Hz
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Buffer size">
              <select
                className={selectCls}
                value={s.bufferSize || bufferSizes[0] || ""}
                onChange={(e) =>
                  void settingsApi.setBufferSize(Number(e.target.value))
                }
              >
                {bufferSizes.length === 0 && <option value="">—</option>}
                {bufferSizes.map((b) => (
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
                          .filter((idx) =>
                            idx === i
                              ? !active
                              : (s.activeOutputChannels[idx] ?? false),
                          );
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
              onChange={(e) =>
                e.target.value && void settingsApi.setMidiOutput(e.target.value)
              }
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
              onChange={(e) =>
                e.target.value && void settingsApi.setMidiInput(e.target.value)
              }
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
          <Field label="Virtual MIDI port (DAW sync test)">
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() =>
                  void settingsApi.setMidiVirtualPort(
                    !s.virtualMidiPortEnabled,
                  )
                }
                className={`self-start rounded-lg border px-3 py-1.5 text-sm ${
                  s.virtualMidiPortEnabled
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-default/60 bg-default/10 text-foreground/50 hover:bg-default/20"
                }`}
              >
                {s.virtualMidiPortEnabled
                  ? "ResoStage Sync — enabled"
                  : "Enable ResoStage Sync"}
              </button>
              <div className="text-xs text-foreground/40">
                {s.virtualMidiPortEnabled
                  ? "Select “ResoStage Sync” as a MIDI input in your DAW to receive the clock/Start/Stop/SPP."
                  : "Creates a virtual MIDI port so you can test clock sync in a DAW without any hardware or IAC setup."}
              </div>
            </div>
          </Field>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Keyboard & MIDI shortcuts</Card.Title>
          <Card.Description>
            Click a key binding and press a key (Esc cancels). Click a MIDI
            binding, then press a pad/CC on the remote input to learn.
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          {ACTION_GROUPS.map((group) => (
            <div key={group.title} className="flex flex-col gap-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">
                {group.title}
              </div>
              {group.actions.map((action) => (
                <BindingRow
                  key={action}
                  action={action}
                  currentKey={keyByAction.get(action) ?? ""}
                  midi={midiByAction.get(action)}
                  learning={learningAction === action}
                  dotVisible={dotVisible}
                  dotDelay={dotDelayFor(action)}
                />
              ))}
            </div>
          ))}
          {/* Any extra actions from the backend not in the static groups */}
          {s.keybindings
            .filter(
              (kb) => !ACTION_GROUPS.some((g) => g.actions.includes(kb.action)),
            )
            .map((kb) => (
              <BindingRow
                key={kb.action}
                action={kb.action}
                currentKey={kb.key}
                midi={midiByAction.get(kb.action)}
                learning={learningAction === kb.action}
                dotVisible={dotVisible}
                dotDelay={dotDelayFor(kb.action)}
              />
            ))}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>System health</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat
              label="CPU (app · 100%=1 core)"
              value={`${Math.max(0, h.cpuPercent ?? 0).toFixed(1)}%`}
            />
            <Stat
              label="RAM (Memory / footprint)"
              value={formatBytes(h.rssBytes)}
            />
            <Stat label="Free system RAM" value={formatBytes(h.freeBytes)} />
            <Stat label="Underruns" value={String(h.underrunCount)} />
            <Stat
              label="Audio callbacks"
              value={String(h.audioCallbackCount)}
            />
            <Stat label="Web clients" value={String(h.webClientCount)} />
          </div>
          {(h.processes?.length ?? 0) > 0 && (
            <div className="rounded-lg bg-default/30 p-3">
              <div className="mb-2 text-xs font-medium uppercase text-default-500">
                Per-process (incl. WebKit helpers)
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-default-500">
                    <th className="pb-1 pr-3">Process</th>
                    <th className="pb-1 pr-3 text-right">PID</th>
                    <th className="pb-1 pr-3 text-right">RSS</th>
                    <th className="pb-1 text-right">CPU</th>
                  </tr>
                </thead>
                <tbody>
                  {(h.processes ?? []).map((p) => (
                    <tr key={p.pid} className="border-t border-default/20">
                      <td className="py-1 pr-3 font-mono text-xs">
                        {p.name || "—"}
                      </td>
                      <td className="py-1 pr-3 text-right font-mono text-xs">
                        {p.pid}
                      </td>
                      <td className="py-1 pr-3 text-right">
                        {formatBytes(p.rssBytes)}
                      </td>
                      <td className="py-1 text-right">
                        {p.cpuPercent.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
