import { Tooltip } from "@heroui/react";
import {
  Activity,
  Music3,
  Palette,
  SlidersHorizontal,
  Workflow,
  Zap,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { FontIcon } from "../components/FontIcon";
import {
  Alert,
  Button,
  Card,
  Select,
  Switch,
  Tabs,
  ToggleButton,
  type SelectOption,
  KeyHint,
} from "../components/ui";
import {
  TIER_DESCRIPTION,
  TIER_FPS,
  TIER_LABEL,
  type PerformanceSettings,
  type PerformanceTier,
} from "../lib/performance";
import {
  THEME_LABELS,
  THEME_NAMES,
  type ThemeName,
} from "../lib/theme";
import {
  readLongImportPreference,
  writeLongImportPreference,
  type LongImportPreference,
} from "../lib/importPrefs";
import { settings as settingsApi } from "../lib/api";
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
    actions: ["play", "stop", "stop_to_start", "next", "prev"],
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
type SettingsTab = "audio" | "midi" | "appearance" | "performance" | "health";

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

      <Section title="Output Device">
        {/* Only worth showing when there is a choice: macOS has CoreAudio and
            nothing else, and a select with one option is furniture. On Windows
            this is where ASIO appears -- and where a rig that came back on
            WASAPI after a restart gets put back. */}
        {s.audioDrivers.length > 1 && (
          <Field label="Driver">
            <Select
              aria-label="Audio driver"
              title="The host audio API. ASIO and JACK reach the same interface with far lower latency than the shared-mode default."
              options={s.audioDrivers.map((d) => ({ id: d, label: d }))}
              value={s.currentAudioDriver || s.audioDrivers[0] || ""}
              onChange={(d) => void settingsApi.setAudioDriver(d)}
            />
          </Field>
        )}
        <Field label="Output device">
          <Select
            aria-label="Output device"
            placeholder="No devices reported"
            // A device that has gone away is still what the engine is
            // configured for, so it stays in the list rather than the control
            // silently reading as some other device.
            options={deviceOptions}
            value={s.currentOutputDevice || outputDevices[0] || ""}
            onChange={(d) => void settingsApi.setAudioOutputDevice(d)}
          />
        </Field>
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
  const disk =
    (h.diskReadBytesPerSec ?? 0) + (h.diskWriteBytesPerSec ?? 0);

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
              <span className="text-sm">Lower the frame rate automatically</span>
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
    <div className="mx-auto flex h-full max-w-3xl flex-col">
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
                {tab.label}
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
          </Tabs.Panel>
        ))}
      </Tabs>
    </div>
  );
}
