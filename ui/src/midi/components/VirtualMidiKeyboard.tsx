// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useEffect, useMemo, useState } from "react";
import { mixer } from "@/lib/state/api";
import type { WebUiState } from "@/lib/state/types";
import { useThemeVersion } from "@/hooks/useThemeVersion";
import { getTrackColor } from "@/lib/theme";
import { getActiveMidiPitches } from "@/lib/midi/activeMidiPitches";
import { VirtualKeyboardHeader } from "@/midi/components/VirtualKeyboardHeader";
import { VirtualKeyboardKeys } from "@/midi/components/VirtualKeyboardKeys";
import { useVirtualKeyboardInput } from "@/midi/hooks/useVirtualKeyboardInput";
import { useVirtualKeyboardPosition } from "@/midi/hooks/useVirtualKeyboardPosition";
import { createVirtualKeyboardLayout } from "@/midi/logic/keyboardLayout";

export function VirtualMidiKeyboard({
  isOpen = true,
  onClose,
  state,
  standalone = false,
}: {
  isOpen?: boolean;
  onClose: () => void;
  state: WebUiState;
  standalone?: boolean;
}) {
  useThemeVersion();
  const [octave, setOctave] = useState<number>(() => {
    const saved = localStorage.getItem("resostage:virtual-keyboard-octave");
    return saved ? Math.max(1, Math.min(7, parseInt(saved, 10))) : 4;
  });
  const [velocity, setVelocity] = useState<number>(() => {
    const saved = localStorage.getItem("resostage:virtual-keyboard-velocity");
    return saved ? Math.max(1, Math.min(127, parseInt(saved, 10))) : 100;
  });

  const {
    position,
    isDragging,
    containerRef,
    handlePointerDownHeader,
    handlePointerMoveHeader,
    handlePointerUpHeader,
    handleResetPosition,
  } = useVirtualKeyboardPosition();

  // Base MIDI note for current octave (C4 = 60).
  const baseNote = (octave + 1) * 12;

  // Persist settings.
  useEffect(() => {
    localStorage.setItem("resostage:virtual-keyboard-octave", String(octave));
  }, [octave]);
  useEffect(() => {
    localStorage.setItem(
      "resostage:virtual-keyboard-velocity",
      String(velocity),
    );
  }, [velocity]);

  // Musical Typing follows Core's focused track. This keeps the floating and
  // standalone keyboards on the same target as the timeline and Piano Roll.
  const instrumentTracks = useMemo(
    () =>
      state.tracks.filter(
        (track) =>
          track.kind === "instrument" ||
          track.kind === "midi" ||
          track.kind === "externalMidi",
      ),
    [state.tracks],
  );

  const activeInstrument = useMemo(() => {
    const focused = instrumentTracks.find(
      (track) => track.id === state.activeTrackId,
    );
    if (focused) return focused;
    // Never silently play a different instrument while an audio/non-MIDI
    // track is the actual focused track.
    if (state.activeTrackId) return null;
    return (
      instrumentTracks.find((track) => track.recordArmed || track.inputMonitoring) ??
      instrumentTracks[0] ??
      null
    );
  }, [instrumentTracks, state.activeTrackId]);

  const activeInstrumentIndex = useMemo(
    () =>
      activeInstrument
        ? state.tracks.findIndex((track) => track.id === activeInstrument.id)
        : -1,
    [state.tracks, activeInstrument],
  );
  const {
    activeNotes,
    isSustainDown,
    releaseAllNotes,
    changeOctave,
    handleKeyMouseDown,
    handleKeyMouseUp,
    handleKeyMouseEnter,
    handleKeyMouseLeave,
  } = useVirtualKeyboardInput({
    activeTrackIndex: activeInstrumentIndex,
    isOpen,
    standalone,
    onClose,
    octave,
    setOctave,
    velocity,
  });
  const activeTrackColor =
    activeInstrumentIndex >= 0
      ? getTrackColor(activeInstrumentIndex)
      : "#0485f7";
  const visibleActiveNotes = useMemo(
    () =>
      new Set([
        ...activeNotes,
        ...(activeInstrument
          ? getActiveMidiPitches(state, activeInstrument.id)
          : []),
      ]),
    [activeNotes, state, activeInstrument],
  );

  // Track has instrument plugin loaded.
  const hasInstrumentPlugin = useMemo(
    () =>
      activeInstrument?.plugins?.some(
        (plugin) => plugin.instrument && !plugin.bypassed,
      ) ?? false,
    [activeInstrument],
  );

  // Construct piano keys for 32 semitones (from offset 0 up to 31, ~2.6 octaves).
  const keysData = useMemo(
    () => createVirtualKeyboardLayout(baseNote),
    [baseNote],
  );

  if (!isOpen && !standalone) return null;

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Virtual MIDI Keyboard"
      style={
        standalone
          ? undefined
          : position
            ? {
                left: `${position.x}px`,
                top: `${position.y}px`,
              }
            : undefined
      }
      className={
        standalone
          ? "w-full h-full flex flex-col bg-background text-xs select-none p-3 overflow-hidden justify-between border-t border-white/5"
          : `fixed ${
              position ? "" : "bottom-9 left-1/2 -translate-x-1/2"
            } z-40 flex flex-col w-[96vw] max-w-170 rounded-2xl border border-white/10 bg-background-secondary/80 backdrop-blur-2xl p-2.5 text-xs select-none shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_2px_6px_rgba(0,0,0,0.35),0_12px_28px_-4px_rgba(0,0,0,0.55),0_36px_84px_-10px_rgba(0,0,0,0.7)] ${
              isDragging ? "cursor-grabbing select-none" : ""
            }`
      }
    >
      {/* Header bar */}
      <VirtualKeyboardHeader
        standalone={standalone}
        onPointerDown={standalone ? undefined : handlePointerDownHeader}
        onPointerMove={standalone ? undefined : handlePointerMoveHeader}
        onPointerUp={standalone ? undefined : handlePointerUpHeader}
        onResetPosition={handleResetPosition}
        activeInstrument={activeInstrument}
        activeInstrumentIndex={activeInstrumentIndex}
        instrumentTracks={instrumentTracks}
        activeTrackColor={activeTrackColor}
        hasInstrumentPlugin={hasInstrumentPlugin}
        onSelectTrack={(id) => {
          releaseAllNotes();
          const index = state.tracks.findIndex((track) => track.id === id);
          if (index >= 0) void mixer.setFocusedTrack(index);
        }}
        octave={octave}
        onChangeOctave={changeOctave}
        velocity={velocity}
        setVelocity={setVelocity}
        isSustainDown={isSustainDown}
        position={position}
        onClose={onClose}
      />

      {/* Piano Keyboard Canvas */}
      <VirtualKeyboardKeys
        keys={keysData.keys}
        totalWhiteKeys={keysData.totalWhiteKeys}
        activeNotes={visibleActiveNotes}
        activeTrackColor={activeTrackColor}
        standalone={standalone}
        onKeyDown={handleKeyMouseDown}
        onKeyUp={handleKeyMouseUp}
        onKeyEnter={handleKeyMouseEnter}
        onKeyLeave={handleKeyMouseLeave}
      />

      {/* Footer hint */}
      <div className="flex items-center justify-between mt-1.5 px-1 text-[10px] text-foreground/45 font-mono">
        <span>Keys active only while open · Z-M (low) · Q-P (high)</span>
        <span>Octave: [ - / + ] · Chords supported</span>
      </div>
    </div>
  );
}
