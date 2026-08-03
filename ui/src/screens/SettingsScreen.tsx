import { Card, Tabs } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { Activity, Monitor, Music3, SlidersHorizontal } from "lucide-react";
import { FontIcon } from "../components/FontIcon";
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
  // Function keys (F1-F12) already come through as "f1".."f12"; everything
  // else just gets lowercased.
  const key = named[e.key] ?? e.key.toLowerCase();

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
  mode_light: "Mode: Light",
  mode_settings: "Mode: Settings",
  section_prev: "Previous section",
  section_next: "Next section",
  section_last: "Last section",
  bar_prev: "Previous bar",
  bar_next: "Next bar",
  undo: "Undo (timeline)",
  redo: "Redo (timeline)",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

function formatMidi(mb: MidiBindingRow | undefined): string {
  if (!mb || !mb.trigger) return "MIDI Learn";
  const ch = mb.channel > 0 ? `ch${mb.channel} ` : "any ";
  if (mb.trigger === "cc") return `${ch}CC ${mb.number}`;
  return `${ch}note ${mb.number}`;
}

function BindingRow({
  action,
  currentKey,
  midi,
  learning,
  lastAction,
  lastActionNonce,
}: {
  action: string;
  currentKey: string;
  midi?: MidiBindingRow;
  learning: boolean;
  lastAction: string;
  lastActionNonce: number;
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

  // Flash this row's dot only when IT was the action that just fired (native
  // hotkey, MIDI, or menu bar -- see WebUiState.lastAction doc comment).
  // Re-triggers on every nonce bump for this action, including repeats.
  const [dotVisible, setDotVisible] = useState(false);
  const dotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (lastActionNonce === 0 || lastAction !== action) return;
    setDotVisible(true);
    if (dotTimer.current) clearTimeout(dotTimer.current);
    dotTimer.current = setTimeout(() => setDotVisible(false), 500);
    return () => {
      if (dotTimer.current) clearTimeout(dotTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastActionNonce]);

  const midiBound = Boolean(midi?.trigger);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-default/10 px-3 py-2">
      <div className="flex items-center gap-2">
        <div
          className={`h-2 w-2 rounded-full bg-accent transition-all duration-300 ${
            dotVisible ? "scale-100 opacity-100" : "scale-0 opacity-0"
          }`}
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
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1 text-sm ${
            learning
              ? "border-accent bg-accent/10 text-accent"
              : "border-default/60 bg-default/20 hover:bg-default/30"
          }`}
          title="Arm MIDI learn — press a pad or CC on the remote input"
          aria-label={
            learning
              ? "Listening for MIDI"
              : midiBound
                ? formatMidi(midi)
                : "MIDI Learn"
          }
        >
          <FontIcon name="midiplug" size={13} />
          {learning ? "Listening…" : midiBound ? formatMidi(midi) : null}
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
    actions: ["mode_player", "mode_mixer", "mode_editor", "mode_light", "mode_settings"],
  },
  {
    title: "Song sections",
    actions: ["section_prev", "section_next", "section_last"],
  },
  {
    title: "Bar navigation",
    actions: ["bar_prev", "bar_next"],
  },
  {
    title: "Timeline",
    actions: ["undo", "redo"],
  },
];

// ─── Tab definitions ──────────────────────────────────────────────────────
type SettingsTab = "audio" | "midi" | "health" | "ui";

const SETTINGS_TABS: { id: SettingsTab; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: "audio", label: "Audio", icon: SlidersHorizontal },
  { id: "midi", label: "MIDI", icon: Music3 },
  { id: "health", label: "Health", icon: Activity },
  { id: "ui", label: "UI Engine", icon: Monitor },
];

// ─── Section wrapper ──────────────────────────────────────────────────────
// Thin wrapper over HeroUI's Card so every tab keeps using the same compound
// component the rest of the app does, without repeating the Header/Title/
// Content boilerplate at every call site.
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        {description && (
          <p className="mt-0.5 text-xs text-foreground/50">{description}</p>
        )}
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">{children}</Card.Content>
    </Card>
  );
}

// ─── Audio Tab ────────────────────────────────────────────────────────────
function AudioTab({ state }: { state: WebUiState }) {
  const s = state.settings;
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
    <div className="flex flex-col gap-4">
      {devicesEmpty && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          Waiting for audio/MIDI device list from the app… If this stays
          empty, restart ResoStage (the native backend on :2899 must be
          running).
        </div>
      )}

      <Section title="Output Device">
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
      </Section>
    </div>
  );
}

// ─── MIDI Tab ─────────────────────────────────────────────────────────────
function MidiTab({ state }: { state: WebUiState }) {
  const s = state.settings;
  const keyByAction = new Map(s.keybindings.map((kb) => [kb.action, kb.key]));
  const midiByAction = new Map(
    (s.midiBindings ?? []).map((mb) => [mb.action, mb]),
  );
  const learningAction = s.midiLearnAction ?? "";

  return (
    <div className="flex flex-col gap-4">
      <Section title="MIDI I/O">
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
                ? "Select \u201cResoStage Sync\u201d as a MIDI input in your DAW to receive the clock/Start/Stop/SPP."
                : "Creates a virtual MIDI port so you can test clock sync in a DAW without any hardware or IAC setup."}
            </div>
          </div>
        </Field>
      </Section>

      <Section
        title="Keyboard & MIDI Shortcuts"
        description="Click a key binding and press a key (Esc cancels). Click a MIDI binding, then press a pad/CC on the remote input to learn."
      >
        <div className="flex flex-col gap-4">
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
                  lastAction={state.lastAction}
                  lastActionNonce={state.lastActionNonce}
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
                lastAction={state.lastAction}
                lastActionNonce={state.lastActionNonce}
              />
            ))}
        </div>
      </Section>
    </div>
  );
}

// ─── Health Tab ───────────────────────────────────────────────────────────
function HealthTab({ state }: { state: WebUiState }) {
  const h = state.health;
  return (
    <div className="flex flex-col gap-4">
      <Section title="System Health">
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
      </Section>
    </div>
  );
}

// ─── UI Tab ───────────────────────────────────────────────────────────────
function UiTab({ state }: { state: WebUiState }) {
  const currentEngine = state.settings.uiRenderEngine || "wkwebview";
  const cefSupported = state.settings.cefSupported ?? true;
  const [selected, setSelected] = useState(currentEngine);

  useEffect(() => {
    setSelected(currentEngine);
  }, [currentEngine]);

  const handleSelect = (engine: "wkwebview" | "cef") => {
    setSelected(engine);
    void settingsApi.setUiRenderEngine(engine);
  };

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Embedded UI Rendering Engine"
        description="Select the native rendering engine used for the embedded application window."
      >
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => handleSelect("wkwebview")}
            className={`flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-colors ${
              selected === "wkwebview"
                ? "border-accent bg-accent/15 text-accent"
                : "border-default/40 bg-default/5 hover:bg-default/10 text-foreground/80"
            }`}
          >
            <div className="text-sm font-semibold">System WebKit (WKWebView)</div>
            <div className="text-xs text-foreground/50">
              Default system browser component. Low memory footprint, basic WebGL support.
            </div>
          </button>

          <button
            type="button"
            disabled={!cefSupported}
            onClick={() => handleSelect("cef")}
            className={`flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-colors ${
              !cefSupported
                ? "opacity-50 cursor-not-allowed border-default/20 bg-default/5 text-foreground/40"
                : selected === "cef"
                ? "border-accent bg-accent/15 text-accent"
                : "border-default/40 bg-default/5 hover:bg-default/10 text-foreground/80"
            }`}
          >
            <div className="text-sm font-semibold flex items-center gap-2">
              Chromium (CEF)
              <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">
                Hardware Accelerated
              </span>
            </div>
            <div className="text-xs text-foreground/50">
              Chromium Blink engine with GPU acceleration. Identical rendering, V8 performance.
            </div>
          </button>
        </div>

        {selected !== currentEngine && (
          <div className="mt-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            Note: Changing the embedded UI engine requires restarting ResoStage to take effect.
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── Main SettingsScreen ──────────────────────────────────────────────────
export function SettingsScreen({ state }: { state: WebUiState }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("audio");

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <Tabs
        selectedKey={activeTab}
        onSelectionChange={(k) => setActiveTab(String(k) as SettingsTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.ListContainer className="shrink-0 border-b border-default/30">
          <Tabs.List aria-label="Settings sections">
            {SETTINGS_TABS.map((tab) => (
              <Tabs.Tab key={tab.id} id={tab.id}>
                <tab.icon size={15} className="mr-1.5 inline-block" />
                {tab.label}
                <Tabs.Indicator className="bg-accent" />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>

        {SETTINGS_TABS.map((tab) => (
          <Tabs.Panel key={tab.id} id={tab.id} className="flex-1 overflow-auto pt-4 pb-6">
            {tab.id === "audio" && <AudioTab state={state} />}
            {tab.id === "midi" && <MidiTab state={state} />}
            {tab.id === "health" && <HealthTab state={state} />}
            {tab.id === "ui" && <UiTab state={state} />}
          </Tabs.Panel>
        ))}
      </Tabs>
    </div>
  );
}
