/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { lazy, Suspense, useState } from "react";
import { SlidersHorizontal, Workflow } from "lucide-react";
import {
  Button,
  Select,
  Switch,
  ToggleButton,
  type SelectOption,
} from "@/components/ui";
import { settings as settingsApi } from "@/lib/state/api";
import type { WebUiState } from "@/lib/state/types";
import {
  readLongImportPreference,
  writeLongImportPreference,
  type LongImportPreference,
} from "@/transfer/audio/logic/importPrefs";
import {
  SettingsField,
  SettingsSection,
  SettingsStat,
} from "@/screens/settings/components/SettingsPrimitives";

// @xyflow/react is a heavy graph library behind exactly one modal. Loading it
// on demand keeps it out of the startup bundle entirely.
const SignalFlowDialog = lazy(() =>
  import("@/screens/settings/audio/components/SignalFlowDialog").then((m) => ({
    default: m.SignalFlowDialog,
  })),
);

export function AudioSettingsTab({ state }: { state: WebUiState }) {
  const [flowOpen, setFlowOpen] = useState(false);
  const [advancedSendRouting, setAdvancedSendRouting] = useState(() =>
    typeof localStorage !== "undefined"
      ? localStorage.getItem("resostage:advanced-send-routing") === "true"
      : false,
  );
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
      <SettingsSection title="Audio Hardware & I/O">
        {s.audioDrivers.length > 0 && (
          <SettingsField label="Audio Driver Type">
            <Select
              aria-label="Audio driver type"
              title="Host audio API (CoreAudio on macOS, WASAPI/ASIO/DirectSound on Windows, ALSA/PulseAudio/JACK on Linux)."
              options={s.audioDrivers.map((d) => ({ id: d, label: d }))}
              value={s.currentAudioDriver || s.audioDrivers[0] || ""}
              onChange={(d) => void settingsApi.setAudioDriver(d)}
            />
          </SettingsField>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <SettingsField label="Output device">
            <Select
              aria-label="Output device"
              placeholder="No devices reported"
              options={deviceOptions}
              value={s.currentOutputDevice || outputDevices[0] || ""}
              onChange={(d) => void settingsApi.setAudioOutputDevice(d)}
            />
          </SettingsField>
          <SettingsField label="Input device">
            <Select
              aria-label="Input device"
              placeholder="No input devices"
              options={inputDeviceOptions}
              value={s.currentInputDevice ?? ""}
              onChange={(d) => void settingsApi.setAudioInputDevice(d)}
            />
          </SettingsField>
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
              Control Panel
            </Button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <SettingsField label="Sample rate">
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
          </SettingsField>
          <SettingsField label="Buffer size">
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
          </SettingsField>
        </div>
        {s.outputChannelNames.length > 0 && (
          <SettingsField label="Active output channels">
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
          </SettingsField>
        )}
        {s.inputChannelNames && s.inputChannelNames.length > 0 && (
          <SettingsField label="Active input channels">
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
                      const activeIndices = s
                        .inputChannelNames!.map((_, idx) => idx)
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
          </SettingsField>
        )}
        {((s.inputLatencyMs ?? 0) > 0 || (s.outputLatencyMs ?? 0) > 0) && (
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border-subtle/50">
            <SettingsStat
              label="Input Latency"
              value={`${(s.inputLatencyMs ?? 0).toFixed(1)} ms`}
            />
            <SettingsStat
              label="Output Latency"
              value={`${(s.outputLatencyMs ?? 0).toFixed(1)} ms`}
            />
            <SettingsStat
              label="Roundtrip"
              value={`${(s.roundtripLatencyMs ?? (s.inputLatencyMs ?? 0) + (s.outputLatencyMs ?? 0)).toFixed(1)} ms`}
            />
          </div>
        )}
      </SettingsSection>

      {devicesEmpty && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          Waiting for audio/MIDI device list from the app… If this stays empty,
          restart ResoStage (the native backend on :2899 must be running).
        </div>
      )}
      <SettingsSection
        title="Recording Count-In"
        description="Play complete bars of the song's click before recording begins. The timeline counts in from the previous bar line and captures at the original cursor position."
      >
        <SettingsField label="Count-in length">
          <Select
            aria-label="Recording count-in length"
            options={[
              { id: "0", label: "Off" },
              { id: "1", label: "1 bar" },
              { id: "2", label: "2 bars" },
            ]}
            value={String(s.countInBars ?? 0)}
            onChange={(value) => void settingsApi.setCountInBars(Number(value))}
          />
          <div className="mt-1 text-xs text-foreground/45">
            Uses the active song's tempo and meter and follows click-strip
            routing. The count-in remains audible while the global metronome
            toggle is off. Saved on this device.
          </div>
        </SettingsField>
      </SettingsSection>

      <SettingsSection
        title="Signal Flow"
        description="Every route the engine is currently rendering: tracks and the metronome through sends and the master, out to physical channels. Mute, solo and send levels are shown live."
      >
        <div>
          <Button size="sm" variant="outline" onPress={() => setFlowOpen(true)}>
            <Workflow size={14} />
            View signal flow
          </Button>
        </div>
      </SettingsSection>

      {flowOpen && (
        <Suspense fallback={null}>
          <SignalFlowDialog onClose={() => setFlowOpen(false)} />
        </Suspense>
      )}

      <SettingsSection
        title="Mixer & Routing"
        description="Controls for how the mixer surface behaves."
      >
        <SettingsField label="Advanced Send Tap Routing">
          <div className="flex items-center gap-3">
            <Switch
              aria-label="Advanced Send Tap Routing"
              isSelected={advancedSendRouting}
              onChange={(checked) => {
                setAdvancedSendRouting(checked);
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
              Show Pre-Fader / Post-Fader / Post-Pan tap mode options on send
              knobs
            </span>
          </div>
        </SettingsField>
      </SettingsSection>

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
    <SettingsSection
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
    </SettingsSection>
  );
}
