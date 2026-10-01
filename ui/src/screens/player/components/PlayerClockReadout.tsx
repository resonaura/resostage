// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import {
  formatClockPrecise as formatTime,
  LiveReadout,
} from "@/components/daw";
import { barBeat, globalBarBeat } from "@/screens/player/logic/timeDisplay";
import type { WebUiState } from "@/lib/state/types";

type PlayerClockReadoutProps = {
  playing: boolean;
  song: WebUiState["songs"][number] | null;
  songLength: number;
  songOffset: number;
  globalBeatsElapsed: number;
  globalPlayheadSeconds: number;
  getLiveAbsolute: () => number;
};

/** Live song-local and project-absolute clock readouts for the Player screen. */
export function PlayerClockReadout({
  playing,
  song,
  songLength,
  songOffset,
  globalBeatsElapsed,
  globalPlayheadSeconds,
  getLiveAbsolute,
}: PlayerClockReadoutProps) {
  // Song-local = absolute − offset of current song (one timeline, not two).
  // A live read, not a rendered value -- see the clock in PlayerScreen.
  const liveSongSeconds = () => Math.max(0, getLiveAbsolute() - songOffset);

  return (
    <div className="flex shrink-0 flex-col justify-center border-b border-default/30 px-4 py-2 sm:border-b-0 sm:border-r sm:px-5 sm:py-2.5">
      <div
        style={{ fontWeight: "100" }}
        className={`font-mono text-2xl tabular-nums tracking-tight leading-none sm:text-3xl ${
          playing ? "text-accent" : "text-foreground"
        }`}
      >
        {/* The clock runs at the full frame rate; the readouts below it
            are coarser on purpose -- a bar/beat that only changes a few
            times a second does not need sampling sixty. */}
        <LiveReadout
          sample={() => formatTime(liveSongSeconds())}
          intervalMs={0}
        />
        {songLength > 0 && (
          <span className="ml-2 text-sm font-normal text-foreground/25">
            / {formatTime(songLength)}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <LiveReadout
          className="font-mono text-base font-semibold tabular-nums text-accent"
          // Per frame. The default 12/s throttle is right for a clock,
          // whose last digit is a blur either way, and wrong for this:
          // bar|beat changes once a beat and the whole value of it is
          // landing on that beat, not up to 83ms after it.
          intervalMs={0}
          sample={() =>
            song ? barBeat(liveSongSeconds(), song.bpm, song.tsNum) : "—"
          }
        />
        <span className="text-[11px] text-foreground/30">bar | beat</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-1.5 opacity-60">
        <LiveReadout
          className="font-mono text-[10px] tabular-nums text-foreground/35"
          sample={() => formatTime(getLiveAbsolute())}
        />
        <LiveReadout
          className="font-mono text-[10px] tabular-nums text-foreground/35"
          intervalMs={0}
          sample={() =>
            song
              ? globalBarBeat(
                  globalBeatsElapsed +
                    Math.max(0, getLiveAbsolute() - globalPlayheadSeconds) *
                      ((song.bpm > 0 ? song.bpm : 120) / 60),
                  song.tsNum,
                )
              : "—"
          }
        />
        <span className="text-[9px] text-foreground/25">abs</span>
      </div>
    </div>
  );
}
