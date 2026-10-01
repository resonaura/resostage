// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { ScrollShadow } from "@heroui/react";
import { memo } from "react";
import { Card } from "@/components/ui";
import type { SongRow } from "@/lib/state/types";

// The setlist is pure project data plus two booleans, but it used to be
// rebuilt -- one <button> subtree per song -- on every telemetry frame simply
// because it lived inline in a component the playhead re-renders. Memoized on
// what it actually reads, it now re-renders when the setlist, the staged song
// or the transport state changes, which is the entire set of things that can
// change how it looks.
export const SetlistPanel = memo(function SetlistPanel({
  songs,
  activeIndex,
  playing,
  onSelect,
}: {
  songs: SongRow[];
  activeIndex: number;
  playing: boolean;
  onSelect: (index: number) => void;
}) {
  return (
    <Card className="flex h-56 min-h-0 flex-1 flex-col overflow-hidden sm:h-auto p-0 gap-0">
      <Card.Header className="h-10 flex flex-row items-center border-b border-default/20 px-3.5 text-[11px] font-bold uppercase tracking-widest text-foreground/35 space-y-0 shrink-0">
        Setlist
      </Card.Header>
      <ScrollShadow orientation="vertical" className="min-h-0 flex-1">
        {songs.length === 0 ? (
          /* Centered vertically when setlist is empty */
          <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-foreground/40">
            No songs in this project.
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-default/15">
            {songs.map((s, i) => {
              const isActive = i === activeIndex;
              const isCurrentPlaying = isActive && playing;

              const toneClass = isCurrentPlaying
                ? "bg-accent-soft hover:bg-accent-soft-hover text-accent-soft-foreground"
                : isActive
                  ? "bg-default-soft hover:bg-default-soft-hover text-foreground"
                  : "hover:bg-default/30 text-foreground/80";

              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSelect(i)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${toneClass}`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all ${
                      isCurrentPlaying
                        ? "animate-pulse scale-125 bg-accent shadow-[0_0_4px_var(--player-active-glow)]"
                        : isActive
                          ? "bg-foreground/50"
                          : "bg-foreground/12"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={`truncate text-sm ${
                        isActive ? "font-semibold" : "text-foreground/80"
                      }`}
                    >
                      {i + 1}. {s.name}
                    </div>
                    <div
                      className={`text-[10px] ${
                        isActive ? "opacity-75" : "text-foreground/35"
                      }`}
                    >
                      {s.bpm.toFixed(1)} bpm ·{" "}
                      {s.mode === "auto" ? "auto" : "wait"} ·{" "}
                      {s.regions?.length ?? 0} clips
                    </div>
                  </div>
                  {isActive && (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide ${
                        isCurrentPlaying
                          ? "bg-accent/20 text-accent"
                          : "bg-default/40 text-foreground/60"
                      }`}
                    >
                      {playing ? "NOW" : "CUE"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </ScrollShadow>
    </Card>
  );
});
