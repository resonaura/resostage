// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import {
  GripVertical,
  Keyboard,
  Minus,
  Plus,
  RotateCcw,
  X,
  Zap,
} from "lucide-react";
import type { Dispatch, PointerEvent, SetStateAction } from "react";
import { TrackStateButtons } from "@/components/daw/TrackStateButtons";
import { Slider } from "@/components/ui";
import type { TrackRow } from "@/lib/state/types";

export function VirtualKeyboardHeader({
  standalone,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onResetPosition,
  activeInstrument,
  activeInstrumentIndex,
  instrumentTracks,
  activeTrackColor,
  hasInstrumentPlugin,
  onSelectTrack,
  octave,
  onChangeOctave,
  velocity,
  setVelocity,
  isSustainDown,
  position,
  onClose,
}: {
  standalone: boolean;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLDivElement>) => void;
  onResetPosition: () => void;
  activeInstrument: TrackRow | null;
  activeInstrumentIndex: number;
  instrumentTracks: TrackRow[];
  activeTrackColor: string;
  hasInstrumentPlugin: boolean;
  onSelectTrack: (trackId: string) => void;
  octave: number;
  onChangeOctave: (octave: number) => void;
  velocity: number;
  setVelocity: Dispatch<SetStateAction<number>>;
  isSustainDown: boolean;
  position: { x: number; y: number } | null;
  onClose: () => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={standalone ? undefined : onResetPosition}
      title={
        standalone
          ? "Musical Typing"
          : "Drag to reposition · Double-click to reset"
      }
      style={
        standalone
          ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
          : undefined
      }
      className={`flex flex-wrap items-center justify-between gap-2 border-b border-default/20 pb-2 mb-2 select-none ${
        standalone ? "" : "cursor-grab active:cursor-grabbing"
      }`}
    >
      <div
        className="flex items-center gap-1.5"
        style={
          standalone
            ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
            : undefined
        }
      >
        {!standalone && (
          <GripVertical
            size={14}
            className="text-foreground/30 hover:text-foreground/60 shrink-0"
          />
        )}
        <div className="flex items-center gap-1.5 font-semibold text-foreground">
          <Keyboard size={16} className="text-accent" />
          <span>Musical Typing</span>
        </div>

        {/* Active target track info & quick arm */}
        {activeInstrument && activeInstrumentIndex >= 0 ? (
          <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-lg bg-default/20 border border-default/30">
            <span className="text-[10px] text-foreground/50 uppercase font-mono">
              Track:
            </span>
            {instrumentTracks.length > 1 ? (
              <select
                value={activeInstrument.id}
                onChange={(event) => onSelectTrack(event.target.value)}
                className="bg-transparent text-xs font-semibold max-w-30 truncate outline-none cursor-pointer"
                style={{ color: activeTrackColor }}
                title="Switch Target Instrument Track"
              >
                {instrumentTracks.map((track) => (
                  <option
                    key={track.id}
                    value={track.id}
                    className="bg-background-secondary text-foreground"
                  >
                    {track.name}
                  </option>
                ))}
              </select>
            ) : (
              <span
                className="text-xs font-semibold max-w-27.5 truncate"
                style={{ color: activeTrackColor }}
              >
                {activeInstrument.name}
              </span>
            )}
            <TrackStateButtons
              track={activeInstrument}
              index={activeInstrumentIndex}
              focused
              compact
            />
            {!hasInstrumentPlugin && (
              <span
                className="text-[9px] text-warning/80 font-mono hidden sm:inline ml-1"
                title="No instrument synth inserted on this track. Add one in the Mixer or Track Header."
              >
                (No synth)
              </span>
            )}
          </div>
        ) : (
          <span className="ml-2 text-[10px] text-foreground/50 font-mono">
            (No instrument track)
          </span>
        )}
      </div>

      {/* Controls: Octave & Velocity & Close */}
      <div
        className="flex items-center gap-3"
        style={
          standalone
            ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
            : undefined
        }
      >
        {/* Octave Controls */}
        <div className="flex items-center gap-1 bg-default/20 border border-default/30 rounded-lg px-1.5 py-0.5">
          <span className="text-[10px] font-mono text-foreground/50 uppercase mr-1">
            Oct
          </span>
          <button
            type="button"
            disabled={octave <= 1}
            onClick={() => onChangeOctave(octave - 1)}
            title="Octave Down (Minus key)"
            className="flex h-5 w-5 items-center justify-center rounded bg-default/30 hover:bg-default/60 disabled:opacity-30 disabled:cursor-default text-foreground"
          >
            <Minus size={12} />
          </button>
          <span className="font-mono text-xs font-bold text-accent px-1 min-w-7 text-center">
            C{octave}
          </span>
          <button
            type="button"
            disabled={octave >= 7}
            onClick={() => onChangeOctave(octave + 1)}
            title="Octave Up (Numpad +)"
            className="flex h-5 w-5 items-center justify-center rounded bg-default/30 hover:bg-default/60 disabled:opacity-30 disabled:cursor-default text-foreground"
          >
            <Plus size={12} />
          </button>
        </div>

        {/* Velocity slider */}
        <div
          className="flex items-center gap-1.5 bg-default/20 border border-default/30 rounded-lg px-2 py-0.5 cursor-pointer"
          onDoubleClick={(event) => {
            event.stopPropagation();
            setVelocity(100);
          }}
          title="Double-click to reset velocity (100)"
        >
          <Zap size={12} className="text-foreground/50 shrink-0" />
          <div className="w-16 sm:w-20 flex items-center">
            <Slider
              aria-label="Note Velocity"
              minValue={1}
              maxValue={127}
              step={1}
              value={velocity}
              onChange={(value) => {
                const next = Array.isArray(value) ? value[0] : value;
                if (typeof next === "number") setVelocity(Math.round(next));
              }}
              className="w-full"
            >
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>
          </div>
          <span className="font-mono text-[10px] text-foreground/70 w-6 text-right tabular-nums">
            {velocity}
          </span>
        </div>

        {/* Sustain pedal (Tab) indicator */}
        <div
          className={`flex items-center gap-1.5 border rounded-lg px-2 py-0.5 text-[10px] font-mono transition-all select-none ${
            isSustainDown
              ? "bg-accent/25 border-accent text-accent font-semibold shadow-[0_0_10px_rgba(255,214,10,0.35)]"
              : "bg-default/20 border-default/30 text-foreground/50"
          }`}
          title="Sustain Pedal (Hold Tab key to sustain notes · CC 64)"
        >
          <span className="font-bold border border-default/30 rounded px-1 text-[9px] bg-default/20 text-foreground/70">
            Tab
          </span>
          <span>Sustain</span>
        </div>

        {/* Dock reset button (visible only when dragged and not in standalone window) */}
        {position && !standalone && (
          <button
            type="button"
            onClick={onResetPosition}
            title="Reset position to bottom center"
            className="flex h-6 w-6 items-center justify-center rounded-lg hover:bg-default/30 text-foreground/40 hover:text-foreground transition-colors"
          >
            <RotateCcw size={13} />
          </button>
        )}

        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          title="Close Musical Typing (Esc / Cmd+K)"
          className="flex h-6 w-6 items-center justify-center rounded-lg hover:bg-default/30 text-foreground/60 hover:text-foreground transition-colors"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
