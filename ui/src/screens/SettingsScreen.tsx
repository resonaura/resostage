import { Tooltip } from "@heroui/react";
import {
  Activity,
  Music3,
  Palette,
  Plug,
  Radio,
  Search,
  SlidersHorizontal,
  Square,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { FontIcon } from "../components/FontIcon";
import { RemoteSettingsSection } from "../components/RemoteSettingsSection";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  KeyHint,
  ScrollShadow,
  Select,
  Switch,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  type SelectOption,
} from "../components/ui";
import {
  pluginCatalog as pluginCatalogApi,
  settings as settingsApi,
  type PluginCatalogResponse,
  type PluginCatalogEntry,
} from "../lib/api";
import {
  displayCategory,
  displayFormat,
  GLOBAL_CATEGORIES,
  SCOPE_FILTERS,
  type ScopeFilterDef,
} from "../lib/pluginCategories";
import {
  readLongImportPreference,
  writeLongImportPreference,
  type LongImportPreference,
} from "../lib/importPrefs";
import {
  TIER_DESCRIPTION,
  TIER_FPS,
  TIER_LABEL,
  type PerformanceSettings,
  type PerformanceTier,
} from "../lib/performance";
import { THEME_LABELS, THEME_NAMES, type ThemeName } from "../lib/theme";
import type { MidiBindingRow, WebUiState } from "../lib/types";
// @xyflow/react is a heavy graph library behind exactly one modal. Loading it
// on demand keeps it out of the startup bundle entirely.
const SignalFlowDialog = lazy(() =>
  import("../components/audio/SignalFlowDialog").then((m) => ({
    default: m.SignalFlowDialog,
  })),
);

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

import { keyEventToDescription } from "../lib/keyEvents";

/** Human labels for the action catalogue (transport / mode / sections). */
const ACTION_LABELS: Record<string, string> = {
  play: "Play / Pause",
  stop: "Stop (pause in place)",
  stop_to_start: "Full stop (return to start)",
  record: "Record (Audio & MIDI)",
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

  // Flash only on a *new* nonce for this action — not when Settings mounts
  // with a stale lastAction (e.g. play) still in state.
  const [dotVisible, setDotVisible] = useState(false);
  const prevNonce = useRef(lastActionNonce);
  const dotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const prev = prevNonce.current;
    prevNonce.current = lastActionNonce;
    if (lastActionNonce === 0 || lastActionNonce === prev) return;
    if (lastAction !== action) return;
    setDotVisible(true);
    if (dotTimer.current) clearTimeout(dotTimer.current);
    dotTimer.current = setTimeout(() => setDotVisible(false), 500);
    return () => {
      if (dotTimer.current) clearTimeout(dotTimer.current);
    };
  }, [lastActionNonce, lastAction, action]);

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
        {/* Both bindings are armed states, not one-shot actions -- "listening"
            has to look held down until a key or a pad arrives. */}
        <Tooltip>
          <ToggleButton
            size="sm"
            tone="accent-soft"
            isSelected={listening}
            onChange={(on) => setListening(on)}
            className="min-w-[7.5rem] tabular-nums"
          >
            {listening ? (
              "Press a key…"
            ) : currentKey ? (
              <KeyHint binding={currentKey} />
            ) : (
              "(unbound)"
            )}
          </ToggleButton>
          <Tooltip.Content>
            Click, then press a key (Esc cancels)
          </Tooltip.Content>
        </Tooltip>
        <Tooltip>
          <ToggleButton
            size="sm"
            tone="accent-soft"
            isSelected={learning}
            onChange={(on) => {
              if (on) void settingsApi.midiLearn(action);
              else void settingsApi.midiLearnCancel();
            }}
            className="min-w-[7.5rem]"
            aria-label={
              learning
                ? "Listening for MIDI"
                : midiBound
                  ? formatMidi(midi)
                  : "MIDI Learn"
            }
          >
            <FontIcon name="midiplug" size={13} />
            {learning ? "Listening…" : midiBound ? formatMidi(midi) : "MIDI"}
          </ToggleButton>
          <Tooltip.Content>
            Arm MIDI learn — press a pad or CC on the remote input
          </Tooltip.Content>
        </Tooltip>
        {midiBound && !learning && (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Clear MIDI binding"
            onPress={() => void settingsApi.midiClear(action)}
          >
            Clear MIDI
          </Button>
        )}
      </div>
    </div>
  );
}

const ACTION_GROUPS: { title: string; actions: string[] }[] = [
  {
    title: "Transport",
    actions: ["play", "stop", "stop_to_start", "record", "next", "prev"],
  },
  {
    title: "Modes",
    actions: [
      "mode_player",
      "mode_mixer",
      "mode_editor",
      "mode_light",
      "mode_settings",
    ],
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
type SettingsTab =
  | "audio"
  | "midi"
  | "appearance"
  | "performance"
  | "health"
  | "plugins"
  | "remote";

const SETTINGS_TABS: {
  id: SettingsTab;
  label: string;
  icon: typeof SlidersHorizontal;
}[] = [
  { id: "audio", label: "Audio", icon: SlidersHorizontal },
  // id stays "midi" so a remembered tab choice keeps working.
  { id: "midi", label: "Keys & MIDI", icon: Music3 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "performance", label: "Performance", icon: Zap },
  { id: "health", label: "Health", icon: Activity },
  { id: "plugins", label: "Plug-ins", icon: Plug },
  { id: "remote", label: "Remote", icon: Radio },
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
  const [flowOpen, setFlowOpen] = useState(false);
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

  const deviceOptions: SelectOption[] = [
    ...(s.currentOutputDevice && !outputDevices.includes(s.currentOutputDevice)
      ? [{ id: s.currentOutputDevice, label: s.currentOutputDevice }]
      : []),
    ...outputDevices.map((d) => ({ id: d, label: d })),
  ];

  const inputDevices =
    s.inputDevices && s.inputDevices.length > 0
      ? s.inputDevices
      : s.currentInputDevice
        ? [s.currentInputDevice]
        : [];

  const inputDeviceOptions: SelectOption[] = [
    { id: "", label: "None (Disabled)" },
    ...(s.currentInputDevice && !inputDevices.includes(s.currentInputDevice)
      ? [{ id: s.currentInputDevice, label: s.currentInputDevice }]
      : []),
    ...inputDevices.map((d) => ({ id: d, label: d })),
  ];

  return (
    <div className="flex flex-col gap-4">
      {devicesEmpty && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          Waiting for audio/MIDI device list from the app… If this stays empty,
          restart ResoStage (the native backend on :2899 must be running).
        </div>
      )}

      <Section
        title="Signal Flow"
        description="Every route the engine is currently rendering: tracks and the metronome through sends and the master, out to physical channels. Mute, solo and send levels are shown live."
      >
        <div>
          <Button size="sm" variant="outline" onPress={() => setFlowOpen(true)}>
            <Workflow size={14} />
            View signal flow
          </Button>
        </div>
      </Section>

      {flowOpen && (
        <Suspense fallback={null}>
          <SignalFlowDialog onClose={() => setFlowOpen(false)} />
        </Suspense>
      )}

      <Section
        title="Mixer & Routing"
        description="Controls for how the mixer surface behaves."
      >
        <Field label="Advanced Send Tap Routing">
          <div className="flex items-center gap-3">
            <Switch
              aria-label="Advanced Send Tap Routing"
              isSelected={
                s.advancedSendRouting ??
                (typeof localStorage !== "undefined" &&
                  localStorage.getItem("resostage:advanced-send-routing") === "true")
              }
              onChange={(checked) => {
                if (typeof localStorage !== "undefined") {
                  localStorage.setItem(
                    "resostage:advanced-send-routing",
                    String(checked),
                  );
                }
                void settingsApi.setAdvancedSendRouting(checked);
              }}
            />
            <span className="text-xs text-foreground/60">
              Show Pre-Fader / Post-Fader / Post-Pan tap mode options on send knobs
            </span>
          </div>
        </Field>
      </Section>

      <Section title="Audio Hardware & I/O">
        {s.audioDrivers.length > 0 && (
          <Field label="Audio Driver Type">
            <Select
              aria-label="Audio driver type"
              title="Host audio API (CoreAudio on macOS, WASAPI/ASIO/DirectSound on Windows, ALSA/PulseAudio/JACK on Linux)."
              options={s.audioDrivers.map((d) => ({ id: d, label: d }))}
              value={s.currentAudioDriver || s.audioDrivers[0] || ""}
              onChange={(d) => void settingsApi.setAudioDriver(d)}
            />
          </Field>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Output device">
            <Select
              aria-label="Output device"
              placeholder="No devices reported"
              options={deviceOptions}
              value={s.currentOutputDevice || outputDevices[0] || ""}
              onChange={(d) => void settingsApi.setAudioOutputDevice(d)}
            />
          </Field>
          <Field label="Input device">
            <Select
              aria-label="Input device"
              placeholder="No input devices"
              options={inputDeviceOptions}
              value={s.currentInputDevice ?? ""}
              onChange={(d) => void settingsApi.setAudioInputDevice(d)}
            />
          </Field>
        </div>
        {(s.hasControlPanel ||
          (s.currentAudioDriver &&
            s.currentAudioDriver.toUpperCase().includes("ASIO"))) && (
          <div className="pt-1">
            <Button
              size="sm"
              variant="outline"
              onPress={() => void settingsApi.showAudioControlPanel()}
            >
              <SlidersHorizontal size={14} />
              Control Panel (Панель управления)
            </Button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Sample rate">
            <Select
              aria-label="Sample rate"
              placeholder="—"
              options={sampleRates.map((r) => ({
                id: String(r),
                label: `${r.toLocaleString()} Hz`,
              }))}
              value={String(s.sampleRate || sampleRates[0] || "")}
              onChange={(v) => void settingsApi.setSampleRate(Number(v))}
            />
          </Field>
          <Field label="Buffer size">
            <Select
              aria-label="Buffer size"
              placeholder="—"
              options={bufferSizes.map((b) => ({
                id: String(b),
                label: `${b} samples`,
              }))}
              value={String(s.bufferSize || bufferSizes[0] || "")}
              onChange={(v) => void settingsApi.setBufferSize(Number(v))}
            />
          </Field>
        </div>
        {s.outputChannelNames.length > 0 && (
          <Field label="Active output channels">
            <div className="flex flex-wrap gap-1.5">
              {s.outputChannelNames.map((name, i) => {
                const active = s.activeOutputChannels[i] ?? false;
                return (
                  <ToggleButton
                    key={i}
                    size="sm"
                    tone="accent-soft"
                    isSelected={active}
                    onChange={() => {
                      const activeIndices = s.outputChannelNames
                        .map((_, idx) => idx)
                        .filter((idx) =>
                          idx === i
                            ? !active
                            : (s.activeOutputChannels[idx] ?? false),
                        );
                      void settingsApi.setOutputChannels(activeIndices);
                    }}
                  >
                    {name}
                  </ToggleButton>
                );
              })}
            </div>
          </Field>
        )}
        {s.inputChannelNames && s.inputChannelNames.length > 0 && (
          <Field label="Active input channels">
            <div className="flex flex-wrap gap-1.5">
              {s.inputChannelNames.map((name, i) => {
                const active = s.activeInputChannels?.[i] ?? false;
                return (
                  <ToggleButton
                    key={i}
                    size="sm"
                    tone="accent-soft"
                    isSelected={active}
                    onChange={() => {
                      const activeIndices = s.inputChannelNames!
                        .map((_, idx) => idx)
                        .filter((idx) =>
                          idx === i
                            ? !active
                            : (s.activeInputChannels?.[idx] ?? false),
                        );
                      void settingsApi.setInputChannels(activeIndices);
                    }}
                  >
                    {name}
                  </ToggleButton>
                );
              })}
            </div>
          </Field>
        )}
        {((s.inputLatencyMs ?? 0) > 0 || (s.outputLatencyMs ?? 0) > 0) && (
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border-subtle/50">
            <Stat
              label="Input Latency"
              value={`${(s.inputLatencyMs ?? 0).toFixed(1)} ms`}
            />
            <Stat
              label="Output Latency"
              value={`${(s.outputLatencyMs ?? 0).toFixed(1)} ms`}
            />
            <Stat
              label="Roundtrip"
              value={`${(s.roundtripLatencyMs ?? ((s.inputLatencyMs ?? 0) + (s.outputLatencyMs ?? 0))).toFixed(1)} ms`}
            />
          </div>
        )}
      </Section>

      <LongImportSection />
    </div>
  );
}

/**
 * What to do when an imported file is longer than the song it lands in.
 *
 * Lives here rather than only in the dialog because the dialog's "always do
 * this" is otherwise a one-way door: once ticked there is nowhere to untick
 * it, and the question stops being asked forever.
 */
function LongImportSection() {
  const [pref, setPref] = useState<LongImportPreference>(() =>
    readLongImportPreference(),
  );
  const choose = (v: LongImportPreference) => {
    setPref(v);
    writeLongImportPreference(v);
  };
  const OPTIONS: { id: LongImportPreference; label: string; hint: string }[] = [
    { id: "ask", label: "Ask each time", hint: "The default." },
    {
      id: "extend",
      label: "Stretch the song",
      hint: "Move the end marker out to the end of the audio.",
    },
    {
      id: "trim",
      label: "Trim the region",
      hint: "Cut it at the end marker. The file itself is untouched.",
    },
  ];

  return (
    <Section
      title="Audio longer than the song"
      description="Only applies to a song whose end you have set by hand -- a song that takes its length from its content just grows to fit."
    >
      <div className="flex flex-col gap-2">
        {OPTIONS.map((o) => (
          <ToggleButton
            key={o.id}
            size="sm"
            tone="accent-soft"
            isSelected={pref === o.id}
            onChange={() => choose(o.id)}
            className="w-full justify-start gap-2 px-3"
          >
            <span className="font-semibold">{o.label}</span>
            <span className="text-xs opacity-70">{o.hint}</span>
          </ToggleButton>
        ))}
      </div>
    </Section>
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

  // The engine reports which ports EXIST but not which one it has open, so
  // these two pickers remember the session's choice locally. That is exactly
  // what the uncontrolled `<select defaultValue="">` they replace did -- the
  // difference is that the state is now visible rather than living in the DOM.
  const [midiOutValue, setMidiOutValue] = useState("");
  const [midiInValue, setMidiInValue] = useState("");

  return (
    <div className="flex flex-col gap-4">
      <Section title="MIDI I/O">
        <Field label="MIDI output (Live Stage / hardware)">
          <Select
            aria-label="MIDI output"
            placeholder="Select MIDI output…"
            options={s.midiOutputs.map((m) => ({ id: m, label: m }))}
            value={midiOutValue}
            onChange={(m) => {
              setMidiOutValue(m);
              void settingsApi.setMidiOutput(m);
            }}
          />
        </Field>
        <Field label="MIDI remote input (footswitch / pads)">
          <Select
            aria-label="MIDI remote input"
            placeholder="Select MIDI remote…"
            options={s.midiInputs.map((m) => ({ id: m, label: m }))}
            value={midiInValue}
            onChange={(m) => {
              setMidiInValue(m);
              void settingsApi.setMidiInput(m);
            }}
          />
        </Field>
        <Field label="Virtual MIDI port (DAW sync test)">
          <div className="flex flex-col gap-1.5">
            <ToggleButton
              size="sm"
              tone="accent-soft"
              className="self-start"
              isSelected={s.virtualMidiPortEnabled}
              onChange={(on) => void settingsApi.setMidiVirtualPort(on)}
            >
              {s.virtualMidiPortEnabled
                ? "ResoStage Sync — enabled"
                : "Enable ResoStage Sync"}
            </ToggleButton>
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

// ─── Appearance Tab ───────────────────────────────────────────────────────

/**
 * A theme swatch: the accent over the panel colour, plus three track colours.
 *
 * Rendered by applying the theme's own selector to a bare element rather than
 * by listing hexes here -- the swatch is then literally the theme, and cannot
 * drift from it.
 */
function ThemeSwatch({ name }: { name: ThemeName }) {
  return (
    <span
      aria-hidden
      // The swatch IS the theme: its own selector is applied here, so it can
      // never drift from what picking it actually does. The default family
      // carries no name -- that is the base stylesheet.
      data-theme="dark"
      {...(name === "default" ? {} : { "data-theme-name": name })}
      className="dark flex h-6 w-12 shrink-0 items-center gap-0.5 overflow-hidden rounded-md border border-default/40 bg-background px-1"
    >
      <span className="h-3 w-3 shrink-0 rounded-full bg-accent" />
      <span
        className="h-3 w-1.5 shrink-0 rounded-sm"
        style={{ background: "var(--track-color-0)" }}
      />
      <span
        className="h-3 w-1.5 shrink-0 rounded-sm"
        style={{ background: "var(--track-color-4)" }}
      />
      <span
        className="h-3 w-1.5 shrink-0 rounded-sm"
        style={{ background: "var(--track-color-8)" }}
      />
    </span>
  );
}

function AppearanceTab({ theme }: { theme: ThemeControls }) {
  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Theme"
        description="Each one recolours the whole interface, including the track, light and bus palettes. Track colours stay as easy to tell apart as the default set — that was measured, not eyeballed."
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {THEME_NAMES.map((name) => (
            <ToggleButton
              key={name}
              size="sm"
              tone="accent-soft"
              isSelected={theme.name === name}
              onChange={() => theme.setName(name)}
              className="w-full justify-start gap-2.5 px-2.5"
            >
              <ThemeSwatch name={name} />
              <span className="font-semibold">{THEME_LABELS[name]}</span>
            </ToggleButton>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ─── Performance Tab ──────────────────────────────────────────────────────

function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0 B/s";
  return `${formatBytes(bytesPerSec)}/s`;
}

function PerformanceTab({
  state,
  performance,
}: {
  state: WebUiState;
  performance: PerformanceControls;
}) {
  const { settings, setSettings, effectiveTier, degraded } = performance;
  const h = state.health;
  const disk = (h.diskReadBytesPerSec ?? 0) + (h.diskWriteBytesPerSec ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Frame rate"
        description="How often the interface redraws. Meters, waveforms and the playhead all share one frame budget, so lowering this lightens every one of them at once. It never affects the audio engine, which runs on its own real-time thread."
      >
        <div className="flex flex-col gap-2">
          {(Object.keys(TIER_FPS) as PerformanceTier[]).map((tier) => (
            <ToggleButton
              key={tier}
              size="sm"
              tone="accent-soft"
              isSelected={settings.tier === tier}
              onChange={() => setSettings({ ...settings, tier })}
              className="w-full justify-start gap-2 px-3"
            >
              <span className="font-semibold">{TIER_LABEL[tier]}</span>
              <span className="text-xs opacity-70">
                {TIER_DESCRIPTION[tier]}
              </span>
            </ToggleButton>
          ))}
        </div>
      </Section>

      <Section
        title="Automatic"
        description="Watches how long frames actually take, plus the engine's own health, and steps down a level when the machine stops keeping up. It only ever goes below the level above, never past it, and climbs back after a long clean stretch."
      >
        <div className="flex items-center justify-between gap-3">
          <Switch
            isSelected={settings.auto}
            onChange={(auto) => setSettings({ ...settings, auto })}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <span className="text-sm">
                Lower the frame rate automatically
              </span>
            </Switch.Content>
          </Switch>
        </div>
        {degraded && (
          <Alert status="warning">
            <Alert.Content>
              <Alert.Title className="text-xs font-semibold">
                Running at {TIER_LABEL[effectiveTier]}
              </Alert.Title>
              <Alert.Description className="text-xs">
                The machine was not keeping up at {TIER_LABEL[settings.tier]}.
                It will go back up on its own once it can.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </Section>

      <Section
        title="What it is watching"
        description="Disk is here because it is the one that hides: a throttling SSD stalls stem streaming and the audio breaks up with the CPU graph flat."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="CPU (app)"
            value={`${Math.max(0, h.cpuPercent ?? 0).toFixed(1)}%`}
          />
          <Stat label="Disk I/O" value={formatRate(disk)} />
          <Stat
            label="Stream starves"
            value={String(h.streamStarveCount ?? 0)}
          />
          <Stat label="Silent blocks" value={String(h.silentBlockCount ?? 0)} />
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
          <Stat label="Silent blocks" value={String(h.silentBlockCount ?? 0)} />
          <Stat
            label="Stream starves"
            value={String(h.streamStarveCount ?? 0)}
          />
          <Stat label="Audio callbacks" value={String(h.audioCallbackCount)} />
          <Stat label="Web clients" value={String(h.webClientCount)} />
        </div>
      </Section>

      <Section
        title="Render callback"
        description="How close each block came to its deadline, and -- when one ran long -- whether it was doing too much work or waiting for a core. Those need opposite fixes and look identical in every other number here. Reset whenever the device changes, so it always describes the current setup."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Worst block (of deadline)"
            value={`${((h.callbackWorstRatio ?? 0) * 100).toFixed(0)}%`}
          />
          <Stat
            label="Worst block"
            value={`${(h.callbackWorstMs ?? 0).toFixed(2)} ms`}
          />
          <Stat
            label="…spent running"
            value={`${((h.callbackWorstCpuShare ?? 0) * 100).toFixed(0)}%`}
          />
          <Stat
            label="Missed deadline"
            value={String(h.callbackOverruns ?? 0)}
          />
          <Stat
            label="Slow: too much work"
            value={String(h.callbackComputeStalls ?? 0)}
          />
          <Stat
            label="Slow: waiting for a core"
            value={String(h.callbackPreemptedStalls ?? 0)}
          />
          <Stat
            label="Output latency"
            value={`${(h.outputLatencyMs ?? 0).toFixed(1)} ms`}
          />
          <Stat
            label="Clock skew"
            value={`${(h.hostTimeSkewMs ?? 0).toFixed(2)} ms`}
          />
        </div>
        {(h.thermalState ?? "nominal") !== "nominal" && (
          <Alert>
            <Alert.Content>
              <Alert.Description>
                The system reports thermal pressure ({h.thermalState}). A
                throttled machine reduces its clocks and moves work to
                efficiency cores, so audio can break up while CPU, RAM and disk
                all read healthy. Cooling the machine is the fix; a larger
                buffer buys time.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        {(h.callbackPreemptedStalls ?? 0) > 0 && (
          <Alert>
            <Alert.Content>
              <Alert.Description>
                Some blocks ran long without using the CPU — they were waiting,
                not working. That points at the machine (another app, disk,
                power settings), not at the size of this show.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
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

// ─── Plug-ins Tab ─────────────────────────────────────────────────────────
// The catalog is intentionally fetched on demand instead of joining the 60 Hz
// live-state payload. It can contain hundreds of rows and only changes after a
// scan, so broadcasting it would waste CPU and network bandwidth.
interface PluginFamily {
  key: string;
  name: string;
  manufacturer: string;
  category: string;
  variants: PluginCatalogEntry[];
}

function pluginFamilyKey(plugin: PluginCatalogEntry): string {
  const normalize = (value: string) =>
    value
      .toLocaleLowerCase()
      .replace(/\b(?:audio\s*unit|vst3?|au)\b/gi, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return `${normalize(plugin.manufacturer)}::${normalize(plugin.name)}`;
}

function groupPluginFamilies(plugins: PluginCatalogEntry[]): PluginFamily[] {
  const grouped = new Map<string, PluginFamily>();
  for (const plugin of plugins) {
    const key = pluginFamilyKey(plugin);
    const cat = displayCategory(plugin);
    const family = grouped.get(key) ?? {
      key,
      name: plugin.name,
      manufacturer: plugin.manufacturer,
      category: cat,
      variants: [],
    };
    if (
      !family.category ||
      family.category === "Other" ||
      family.category === "Effect" ||
      family.category === "Fx"
    ) {
      family.category = cat;
    }
    family.variants.push(plugin);
    grouped.set(key, family);
  }
  return [...grouped.values()]
    .map((family) => ({
      ...family,
      variants: family.variants.sort((a, b) => a.format.localeCompare(b.format)),
    }))
    .sort((a, b) =>
      `${a.manufacturer}\0${a.name}`.localeCompare(
        `${b.manufacturer}\0${b.name}`,
        undefined,
        { sensitivity: "base" },
      ),
    );
}

function PluginsTab() {
  const [catalog, setCatalog] = useState<PluginCatalogResponse | null>(null);
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilterDef["id"]>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [requestError, setRequestError] = useState("");

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await pluginCatalogApi.list();
        if (disposed) return;
        setCatalog(next);
        setRequestError("");
      } catch (error) {
        if (!disposed)
          setRequestError(
            error instanceof Error ? error.message : "Could not load plug-ins",
          );
      }
    };
    void refresh();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (catalog?.scan.state !== "scanning") return;
    const timer = setInterval(() => {
      void pluginCatalogApi.list().then(setCatalog).catch((error: unknown) => {
        setRequestError(
          error instanceof Error ? error.message : "Could not refresh scan state",
        );
      });
    }, 750);
    return () => clearInterval(timer);
  }, [catalog?.scan.state]);

  const beginScan = async (rescanAll: boolean) => {
    try {
      setRequestError("");
      await pluginCatalogApi.scan(rescanAll);
      const next = await pluginCatalogApi.list();
      setCatalog(next);
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Could not start scan",
      );
    }
  };

  const cancelScan = async () => {
    try {
      setRequestError("");
      await pluginCatalogApi.cancelScan();
      setCatalog(await pluginCatalogApi.list());
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Could not cancel scan",
      );
    }
  };

  const setPluginEnabled = async (
    plugin: PluginCatalogEntry,
    enabled: boolean,
  ) => {
    setCatalog((current) =>
      current === null
        ? current
        : {
            ...current,
            catalog: {
              ...current.catalog,
              plugins: current.catalog.plugins.map((candidate) =>
                candidate.id === plugin.id
                  ? { ...candidate, enabled }
                  : candidate,
              ),
            },
          },
    );
    try {
      await pluginCatalogApi.setEnabled(plugin.id, enabled);
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Could not update plug-in",
      );
      setCatalog(await pluginCatalogApi.list());
    }
  };

  const plugins = catalog?.catalog.plugins;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const families = useMemo(
    () => groupPluginFamilies(plugins ?? []),
    [plugins],
  );
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const family of families) {
      const variants = family.variants;
      const matchesScope =
        scopeFilter === "all" ||
        (scopeFilter === "effects" &&
          variants.some((plugin) => !plugin.instrument && (plugin.inputs ?? 2) > 0)) ||
        (scopeFilter === "instruments" &&
          variants.some((plugin) => plugin.instrument)) ||
        (scopeFilter === "multi-io" &&
          variants.some(
            (plugin) => (plugin.inputs ?? 2) > 2 || (plugin.outputs ?? 2) > 2,
          )) ||
        (scopeFilter === "new" &&
          variants.some((plugin) => plugin.isNew));
      if (!matchesScope) continue;
      const catKey = family.category.toLowerCase();
      counts.set(catKey, (counts.get(catKey) ?? 0) + 1);
    }
    return counts;
  }, [families, scopeFilter]);

  const availableCategories = useMemo(() => {
    return GLOBAL_CATEGORIES.filter((cat) => {
      if (cat.id === "all") return true;
      const count = categoryCounts.get(cat.id) ?? 0;
      return count > 0 || categoryFilter === cat.id;
    });
  }, [categoryCounts, categoryFilter]);

  const filtered = useMemo(
    () =>
      families.filter((family) => {
        if (scopeFilter === "quarantined") return false;
        const variants = family.variants;
        const matchesScope =
          scopeFilter === "all" ||
          (scopeFilter === "effects" &&
            variants.some((plugin) => !plugin.instrument && (plugin.inputs ?? 2) > 0)) ||
          (scopeFilter === "instruments" &&
            variants.some((plugin) => plugin.instrument)) ||
          (scopeFilter === "multi-io" &&
            variants.some(
              (plugin) => (plugin.inputs ?? 2) > 2 || (plugin.outputs ?? 2) > 2,
            )) ||
          (scopeFilter === "new" &&
            variants.some((plugin) => plugin.isNew));
        if (!matchesScope) return false;

        const matchesCategory =
          categoryFilter === "all" ||
          family.category.toLowerCase() === categoryFilter.toLowerCase();
        if (!matchesCategory) return false;

        if (!normalizedQuery) return true;
        return variants.some((plugin) =>
          [
            plugin.name,
            plugin.manufacturer,
            family.category,
            plugin.category,
            plugin.format,
          ].some((value) =>
            Boolean(value && value.toLocaleLowerCase().includes(normalizedQuery)),
          ),
        );
      }),
    [families, scopeFilter, categoryFilter, normalizedQuery],
  );

  const quarantined = useMemo(
    () =>
      (catalog?.catalog.blacklist ?? []).filter(
        (item) =>
          scopeFilter === "quarantined" &&
          (!normalizedQuery || item.toLocaleLowerCase().includes(normalizedQuery)),
      ),
    [catalog?.catalog.blacklist, scopeFilter, normalizedQuery],
  );

  const visible = filtered.slice(0, 250);
  const scanning = catalog?.scan.state === "scanning";
  const resultCount =
    scopeFilter === "quarantined" ? quarantined.length : filtered.length;
  const newCount = (plugins ?? []).filter((plugin) => plugin.isNew).length;
  const quarantinedCount = catalog?.catalog.blacklist.length ?? 0;

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden">
      <Card.Header className="shrink-0 gap-3.5 border-b border-default/20 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <Card.Title>Audio Plug-ins</Card.Title>
            <p className="truncate text-[11px] text-foreground/45">
              Isolated VST3/AU discovery · disabled items stay out of insert menus
            </p>
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-foreground/50">
            {plugins?.length ?? 0} plug-ins · {families.length} families ·{" "}
            {catalog?.catalog.blacklist.length ?? 0} quarantined
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            isDisabled={scanning}
            onPress={() => void beginScan(false)}
          >
            <Plug size={14} />
            {scanning ? "Scanning…" : "Scan new or changed"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            isDisabled={scanning}
            onPress={() => void beginScan(true)}
          >
            Rescan all
          </Button>
          {scanning && (
            <Button size="sm" variant="danger-soft" onPress={() => void cancelScan()}>
              <Square size={12} fill="currentColor" />
              Cancel
            </Button>
          )}
          <label className="relative ml-auto min-w-[14rem] flex-1 sm:max-w-sm">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground/35"
            />
            <input
              aria-label="Search plug-ins"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, vendor, category, format…"
              className="h-8 w-full rounded-lg border border-default/35 bg-default/15 pl-9 pr-8 text-xs outline-none transition-colors focus:border-accent"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear plug-in search"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-foreground"
              >
                <X size={14} />
              </button>
            )}
          </label>
        </div>

        {scanning && (
          <div className="grid gap-1" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-[11px] text-foreground/55">
              <span className="truncate">
                Stage {catalog.scan.formatIndex || 1} of{" "}
                {catalog.scan.formatCount || "…"} ·{" "}
                {catalog.scan.format || "Preparing scanner"}
              </span>
              <span className="shrink-0 tabular-nums">
                {Math.round((catalog.scan.progress ?? 0) * 100)}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-default/30">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{
                  width: `${Math.max(1, Math.min(100, (catalog.scan.progress ?? 0) * 100))}%`,
                }}
              />
            </div>
            <div className="truncate text-xs text-foreground/50">
              {catalog.scan.currentPlugin || "Finding installed plug-ins…"}
            </div>
          </div>
        )}

        {(requestError || catalog?.scan.error) && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Description>
                {requestError || catalog?.scan.error}
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-foreground/45">
            Type
          </span>
          <ToggleButtonGroup
            size="xs"
            isDetached
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([scopeFilter])}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (next) setScopeFilter(String(next) as ScopeFilterDef["id"]);
            }}
            aria-label="Filter by plug-in type"
            className="flex flex-wrap gap-1.5"
          >
            {SCOPE_FILTERS.map(({ id, label, icon: Icon, tone }) => {
              const count =
                id === "new"
                  ? newCount
                  : id === "quarantined"
                    ? quarantinedCount
                    : undefined;
              return (
                <ToggleButton
                  key={id}
                  id={id}
                  tone={tone}
                  onPress={() => setScopeFilter(id)}
                  className="gap-1.5 px-3 py-1 text-xs"
                >
                  <Icon size={12} className="shrink-0" />
                  <span>{label}</span>
                  {count != null && count > 0 && (
                    <span className="ml-1 rounded-full bg-default/30 px-1 text-[9px] font-mono tabular-nums">
                      {count}
                    </span>
                  )}
                </ToggleButton>
              );
            })}
          </ToggleButtonGroup>
        </div>

        {scopeFilter !== "quarantined" && (
          <div className="flex flex-wrap items-center gap-3 pt-0.5">
            <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-foreground/45">
              Category
            </span>
            <ToggleButtonGroup
              size="xs"
              isDetached
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={new Set([categoryFilter])}
              onSelectionChange={(keys) => {
                const next = Array.from(keys)[0];
                if (next) setCategoryFilter(String(next));
              }}
              aria-label="Filter by plug-in category"
              className="flex flex-wrap gap-1.5"
            >
              {availableCategories.map(({ id, label }) => {
                const count =
                  id === "all"
                    ? undefined
                    : categoryCounts.get(id);
                return (
                  <ToggleButton
                    key={id}
                    id={id}
                    tone="accent-soft"
                    onPress={() => setCategoryFilter(id)}
                    className="px-3 py-1 text-xs"
                  >
                    <span>{label}</span>
                    {count != null && (
                      <span className="ml-1 text-[10px] font-mono opacity-50 tabular-nums">
                        {count}
                      </span>
                    )}
                  </ToggleButton>
                );
              })}
            </ToggleButtonGroup>
          </div>
        )}
      </Card.Header>

      <Card.Content className="min-h-0 flex-1 p-0">
        <ScrollShadow className="h-full overflow-y-auto" orientation="vertical">
          {resultCount === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-foreground/45">
              {catalog === null
                ? "Loading catalog…"
                : (plugins?.length ?? 0) === 0
                  ? "Run a scan to discover installed plug-ins."
                  : "No plug-ins match this view."}
            </div>
          ) : scopeFilter === "quarantined" ? (
            quarantined.map((item) => (
              <div
                key={item}
                className="border-b border-danger/20 bg-danger/8 px-4 py-2.5 last:border-b-0"
              >
                <div className="truncate text-xs font-semibold text-danger">
                  Scan failed · quarantined
                </div>
                <div className="truncate font-mono text-[10px] text-foreground/50">
                  {item}
                </div>
              </div>
            ))
          ) : (
            visible.map((family) => {
              const isNew = family.variants.some((plugin) => plugin.isNew);
              return (
              <div
                key={family.key}
                className={`grid gap-2 border-b px-4 py-2.5 last:border-b-0 lg:grid-cols-[minmax(12rem,1fr)_minmax(20rem,1.35fr)] ${
                  isNew
                    ? "border-warning/25 bg-warning/8"
                    : "border-default/20"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold">{family.name}</span>
                    {isNew && (
                      <span className="shrink-0 text-[10px] font-bold uppercase text-warning">
                        New
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-foreground/45">
                    {family.manufacturer || "Unknown vendor"}
                    {family.category ? ` · ${family.category}` : ""}
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                  {family.variants.map((plugin) => (
                    <Checkbox
                      key={plugin.id}
                      isSelected={plugin.enabled !== false}
                      onChange={(enabled) =>
                        void setPluginEnabled(plugin, enabled)
                      }
                      aria-label={`${plugin.enabled === false ? "Enable" : "Disable"} ${plugin.name} ${displayFormat(plugin.format)}`}
                    >
                      <Checkbox.Content className="gap-1.5">
                        <Checkbox.Control>
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                        <span className="rounded-md bg-default/20 px-1.5 py-0.5 text-[10px] font-semibold">
                          {displayFormat(plugin.format)}
                        </span>
                        <span className="whitespace-nowrap font-mono text-[10px] text-foreground/45">
                          {plugin.instrument ? "instrument" : `${plugin.inputs ?? 2}→${plugin.outputs ?? 2}`}
                        </span>
                      </Checkbox.Content>
                    </Checkbox>
                  ))}
                  {family.variants.some(
                    (plugin) => (plugin.inputs ?? 2) > 2 || (plugin.outputs ?? 2) > 2,
                  ) && (
                    <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                      Multi-I/O · main stereo pair hosted
                    </span>
                  )}
                  {family.variants.some((plugin) => plugin.instrument) && (
                    <span className="rounded-md bg-secondary/15 px-1.5 py-0.5 text-[10px] font-semibold text-secondary">
                      Instrument
                    </span>
                  )}
                </div>
              </div>
              );
            })
          )}
        </ScrollShadow>
      </Card.Content>
      <Card.Footer className="shrink-0 justify-between border-t border-default/20 px-4 py-2 text-[11px] text-foreground/45">
        <span>{resultCount} matching</span>
        {filtered.length > visible.length && scopeFilter !== "quarantined" && (
          <span>
            Showing {visible.length}; narrow the search for bounded rendering
          </span>
        )}
      </Card.Footer>
    </Card>
  );
}

// ─── Main SettingsScreen ──────────────────────────────────────────────────
export interface ThemeControls {
  name: ThemeName;
  setName: (name: ThemeName) => void;
}

export interface PerformanceControls {
  settings: PerformanceSettings;
  setSettings: (s: PerformanceSettings) => void;
  effectiveTier: PerformanceTier;
  degraded: boolean;
}

export function SettingsScreen({
  state,
  performance,
  theme,
}: {
  state: WebUiState;
  performance: PerformanceControls;
  theme: ThemeControls;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("audio");

  return (
    <div className="flex h-full w-full flex-col">
      <Tabs
        variant="accent-soft"
        selectedKey={activeTab}
        onSelectionChange={(k) => setActiveTab(String(k) as SettingsTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.ListContainer className="shrink-0 border-b border-default/30">
          <Tabs.List aria-label="Settings sections">
            {SETTINGS_TABS.map((tab) => (
              <Tabs.Tab key={tab.id} id={tab.id}>
                <tab.icon size={15} className="mr-1.5 inline-block" />
                <span className="whitespace-nowrap">{tab.label}</span>
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>

        {SETTINGS_TABS.map((tab) => (
          <Tabs.Panel
            key={tab.id}
            id={tab.id}
            className="flex-1 overflow-auto pt-4 pb-6"
          >
            {tab.id === "audio" && <AudioTab state={state} />}
            {tab.id === "midi" && <MidiTab state={state} />}
            {tab.id === "appearance" && <AppearanceTab theme={theme} />}
            {tab.id === "performance" && (
              <PerformanceTab state={state} performance={performance} />
            )}
            {tab.id === "health" && <HealthTab state={state} />}
            {tab.id === "plugins" && <PluginsTab />}
            {tab.id === "remote" && <RemoteSettingsSection />}
          </Tabs.Panel>
        ))}
      </Tabs>
    </div>
  );
}
