/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Tooltip } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { FontIcon } from "@/components/common/FontIcon";
import { Button, KeyHint, ToggleButton } from "@/components/ui";
import { settings as settingsApi } from "@/lib/state/api";
import type { MidiBindingRow, WebUiState } from "@/lib/state/types";
import { hotkeyManager } from "@/lib/interaction/HotkeyManager";
import { keyEventToDescription } from "@/lib/interaction/keyEvents";
import { sendKeyCaptureActive } from "@/lib/platform/electronBridge";
import {
  SettingsField,
  SettingsSection,
} from "@/screens/settings/components/SettingsPrimitives";
import {
  sameDeviceSelection,
  toggleDeviceSelection,
  toggleMidiInputSelection,
} from "@/screens/settings/midi/logic/deviceSelection";

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
  midiAssignable = false,
  learning,
  lastAction,
  lastActionNonce,
}: {
  action: string;
  currentKey: string;
  midi?: MidiBindingRow;
  midiAssignable?: boolean;
  learning: boolean;
  lastAction: string;
  lastActionNonce: number;
}) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const releaseHotkeyCapture = hotkeyManager.beginKeyCapture();
    sendKeyCaptureActive(true);
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const desc = keyEventToDescription(e);
      setListening(false);
      if (desc && desc !== "__cancel__")
        void settingsApi.setKeybinding(action, desc);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      releaseHotkeyCapture();
      sendKeyCaptureActive(false);
    };
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
        <span className="min-w-40 text-sm">{actionLabel(action)}</span>
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
            className="min-w-30 tabular-nums"
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
        {midiAssignable && (
          <Tooltip>
            <ToggleButton
              size="sm"
              tone="accent-soft"
              isSelected={learning}
              onChange={(on) => {
                if (on) void settingsApi.midiLearn(action);
                else void settingsApi.midiLearnCancel();
              }}
              className="min-w-30"
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
        )}
        {midiAssignable && midiBound && !learning && (
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

export function MidiSettingsTab({ state }: { state: WebUiState }) {
  const s = state.settings;
  const keyByAction = new Map(s.keybindings.map((kb) => [kb.action, kb.key]));
  const keybindingByAction = new Map(
    s.keybindings.map((kb) => [kb.action, kb]),
  );
  const midiByAction = new Map(
    (s.midiBindings ?? []).map((mb) => [mb.action, mb]),
  );
  const learningAction = s.midiLearnAction ?? "";
  const [pendingMidiOutputs, setPendingMidiOutputs] = useState<string[] | null>(
    null,
  );
  const [pendingMidiInputs, setPendingMidiInputs] = useState<string[] | null>(
    null,
  );
  const selectedMidiOutputs = pendingMidiOutputs ?? s.selectedMidiOutputs ?? [];
  const selectedMidiInputs = pendingMidiInputs ?? s.selectedMidiInputs ?? [];

  useEffect(() => {
    if (
      pendingMidiOutputs &&
      sameDeviceSelection(pendingMidiOutputs, s.selectedMidiOutputs ?? [])
    ) {
      setPendingMidiOutputs(null);
    }
  }, [pendingMidiOutputs, s.selectedMidiOutputs]);

  useEffect(() => {
    if (
      pendingMidiInputs &&
      sameDeviceSelection(pendingMidiInputs, s.selectedMidiInputs ?? [])
    ) {
      setPendingMidiInputs(null);
    }
  }, [pendingMidiInputs, s.selectedMidiInputs]);

  // Keep rejected/offline commands from leaving an optimistic choice displayed.
  useEffect(() => {
    if (!pendingMidiOutputs) return;
    const timeout = window.setTimeout(() => setPendingMidiOutputs(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [pendingMidiOutputs]);

  useEffect(() => {
    if (!pendingMidiInputs) return;
    const timeout = window.setTimeout(() => setPendingMidiInputs(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [pendingMidiInputs]);

  const toggleMidiOutput = (deviceName: string) => {
    const next = toggleDeviceSelection(selectedMidiOutputs, deviceName);
    setPendingMidiOutputs(next);
    void settingsApi.setMidiOutput(next);
  };

  const toggleMidiInput = (deviceName: string) => {
    const next = toggleMidiInputSelection(selectedMidiInputs, deviceName);
    setPendingMidiInputs(next);
    void settingsApi.setMidiInput(next);
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title="MIDI I/O">
        <SettingsField label="MIDI output devices">
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label="MIDI output devices"
          >
            {s.midiOutputs.map((deviceName) => (
              <ToggleButton
                key={deviceName}
                size="sm"
                tone="accent-soft"
                isSelected={selectedMidiOutputs.includes(deviceName)}
                onChange={() => toggleMidiOutput(deviceName)}
              >
                {deviceName}
              </ToggleButton>
            ))}
            {s.midiOutputs.length === 0 && (
              <span className="text-xs text-foreground/45">
                No MIDI outputs available
              </span>
            )}
          </div>
          <span className="text-xs text-foreground/45">
            MIDI is sent to every selected output. Leave all off to disable
            hardware output.
          </span>
        </SettingsField>
        <SettingsField label="MIDI input devices">
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label="MIDI input devices"
          >
            {s.midiInputs.map((deviceName) => (
              <ToggleButton
                key={deviceName}
                size="sm"
                tone="accent-soft"
                isSelected={selectedMidiInputs.includes(deviceName)}
                onChange={() => toggleMidiInput(deviceName)}
              >
                {deviceName}
              </ToggleButton>
            ))}
            {s.midiInputs.length === 0 && (
              <span className="text-xs text-foreground/45">
                No MIDI inputs available
              </span>
            )}
          </div>
          <span className="text-xs text-foreground/45">
            Select several controllers, or choose All Inputs to accept every
            available device.
          </span>
        </SettingsField>
        <SettingsField label="Virtual MIDI port (DAW sync test)">
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
                ? "Select “ResoStage Sync” as a MIDI input in your DAW to receive the clock/Start/Stop/SPP."
                : "Creates a virtual MIDI port so you can test clock sync in a DAW without any hardware or IAC setup."}
            </div>
          </div>
        </SettingsField>
      </SettingsSection>

      <SettingsSection
        title="Keyboard & MIDI Shortcuts"
        description="Global actions can be rebound and are saved in app settings. Editor selection and note-editing gestures stay fixed and context-scoped. MIDI Learn is limited to transport, navigation, and performance controls."
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
                  midiAssignable={
                    keybindingByAction.get(action)?.midiAssignable
                  }
                  midi={midiByAction.get(action)}
                  learning={learningAction === action}
                  lastAction={state.lastAction}
                  lastActionNonce={state.lastActionNonce}
                />
              ))}
            </div>
          ))}
          {s.keybindings
            .filter(
              (kb) =>
                !ACTION_GROUPS.some((group) =>
                  group.actions.includes(kb.action),
                ),
            )
            .map((kb) => (
              <BindingRow
                key={kb.action}
                action={kb.action}
                currentKey={kb.key}
                midiAssignable={kb.midiAssignable}
                midi={midiByAction.get(kb.action)}
                learning={learningAction === kb.action}
                lastAction={state.lastAction}
                lastActionNonce={state.lastActionNonce}
              />
            ))}
        </div>
      </SettingsSection>
    </div>
  );
}
