// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { TrackStateButtons } from "@/components/daw/TrackStateButtons";
import type { MidiRegionRow, TrackRow } from "@/lib/state/types";

interface PianoRollHeaderProps {
  region: MidiRegionRow;
  track?: TrackRow | null;
  tracks?: TrackRow[];
  onSelectTrack?: (trackId: string) => void;
  regions?: MidiRegionRow[];
  onSelectRegion?: (regionId: string) => void;
  selectedRegionIds?: string[];
  onToggleRegionVisible?: (regionId: string, visible: boolean) => void;
  trackColorIndex: number;
  effectiveTrackColor: string;
}

/** Track linkage, track controls, and region visibility for the Piano Roll. */
export function PianoRollHeader({
  region,
  track,
  tracks,
  onSelectTrack,
  regions,
  onSelectRegion,
  selectedRegionIds,
  onToggleRegionVisible,
  trackColorIndex,
  effectiveTrackColor,
}: PianoRollHeaderProps) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-default/20 border-b border-default/30 text-xs font-semibold select-none">
      <div className="flex items-center gap-2 min-w-0">
        {/* Track linkage pill/badge */}
        {track ? (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-default/30 bg-surface/50">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0 shadow-sm"
              style={{ backgroundColor: effectiveTrackColor }}
            />
            <span
              className="font-semibold text-foreground truncate max-w-30"
              title={track.name || track.id}
            >
              {track.name || track.id}
            </span>
            {tracks &&
              onSelectTrack &&
              (() => {
                const instrumentTracks = tracks.filter(
                  (candidate) => candidate.kind === "instrument" || candidate.kind === "midi" || candidate.kind === "externalMidi",
                );
                if (instrumentTracks.length <= 1) return null;
                return (
                  <select
                    aria-label="Switch active track"
                    value={track.id}
                    onChange={(event) => onSelectTrack(event.target.value)}
                    className="bg-transparent text-[10px] text-foreground/60 hover:text-foreground cursor-pointer outline-none border-none ml-0.5"
                  >
                    {instrumentTracks.map((candidate) => (
                      <option
                        key={candidate.id}
                        value={candidate.id}
                        className="bg-background text-foreground"
                      >
                        {candidate.name || candidate.id}
                      </option>
                    ))}
                  </select>
                );
              })()}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-default/30 bg-surface/50">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 shrink-0" />
            <span className="text-foreground/70">Unlinked</span>
          </div>
        )}

        {track && trackColorIndex >= 0 && (
          <TrackStateButtons track={track} index={trackColorIndex} focused compact />
        )}

        {/* Region selector or name */}
        {regions && regions.length > 1 && onSelectRegion ? (
          <div className="flex items-center gap-1">
            <span className="text-foreground/40">&middot;</span>
            <select
              aria-label="Select MIDI region"
              value={region.id}
              onChange={(event) => onSelectRegion(event.target.value)}
              className="bg-surface/60 border border-default/30 rounded px-1.5 py-0.5 text-xs text-foreground font-medium outline-none cursor-pointer hover:border-accent/40"
            >
              {regions.map((candidate) => (
                <option
                  key={candidate.id}
                  value={candidate.id}
                  className="bg-background text-foreground"
                >
                  {candidate.name || candidate.id} ({candidate.notes.length} notes)
                </option>
              ))}
            </select>
            {selectedRegionIds && onToggleRegionVisible && (
              <details className="relative">
                <summary className="cursor-pointer list-none rounded border border-default/30 bg-surface/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70 hover:border-accent/40">
                  {selectedRegionIds.length} visible
                </summary>
                <div className="absolute left-0 top-full z-50 mt-1 min-w-52 rounded-md border border-default/40 bg-background/95 p-2 shadow-xl backdrop-blur">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
                    Visible MIDI regions
                  </div>
                  {regions.map((candidate) => {
                    const checked = selectedRegionIds.includes(candidate.id);
                    const isPrimary = candidate.id === region.id;
                    return (
                      <label
                        key={candidate.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-default/15"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={isPrimary}
                          onChange={(event) =>
                            onToggleRegionVisible(candidate.id, event.target.checked)
                          }
                        />
                        <span className="min-w-0 flex-1 truncate text-[11px]">
                          {candidate.name || candidate.id}
                        </span>
                        {isPrimary && (
                          <span className="text-[9px] font-semibold text-accent">
                            EDIT
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="text-foreground/40">&middot;</span>
            <span className="text-foreground font-semibold">
              {region.name || "MIDI Region"}
            </span>
          </div>
        )}

        <span className="text-[10px] font-normal text-foreground/50">
          ({region.notes.length} notes)
        </span>
      </div>

      <div className="flex items-center gap-2 text-[11px] font-normal text-foreground/60 shrink-0">
        <span>
          {region.durationBeats} beats
          {region.loop ? ` (Repeats every ${region.loopLengthBeats}b)` : ""}
        </span>
      </div>
    </div>
  );
}
