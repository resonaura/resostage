/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useMemo, type ComponentProps } from "react";
import type { MidiRegionRow, SongRow } from "@/lib/state/types";
import type { PianoRollViewport } from "@/screens/editor/pianoroll/logic/types";
import { createPianoRollProjectAxis } from "@/screens/editor/pianoroll/logic/projectAxis";
import { Ruler } from "@/screens/editor/timeline/ruler/components/Ruler";
import { CycleStrip } from "@/screens/editor/timeline/cycle/components/CycleStrip";
import type { CycleLocators } from "@/screens/editor/timeline/cycle/hooks/useCycleState";

type CycleStripProps = ComponentProps<typeof CycleStrip>;
export type PianoRollCycleSetRange = CycleStripProps["onSetRange"];

interface PianoRollProjectHeaderProps {
  song?: SongRow;
  cycle?: CycleLocators;
  songLength: number;
  songIndex: number;
  cycleOwner: boolean;
  regionStartBeats: MidiRegionRow["startBeats"];
  viewport: PianoRollViewport;
  canvasWidth: number;
  timeSignatureNumerator: number;
  snap: number;
  onCycleToggleActive?: () => void;
  onCycleSetRange?: CycleStripProps["onSetRange"];
  onCycleToggleSkip?: () => void;
  onCycleDragEnd?: () => void;
}

export function PianoRollProjectHeader({
  song,
  cycle,
  songLength,
  songIndex,
  cycleOwner,
  regionStartBeats,
  viewport,
  canvasWidth,
  timeSignatureNumerator,
  snap,
  onCycleToggleActive,
  onCycleSetRange,
  onCycleToggleSkip,
  onCycleDragEnd,
}: PianoRollProjectHeaderProps) {
  const projectAxis = useMemo(() => song ? createPianoRollProjectAxis(song) : null, [song]);
  if (!song || !cycle || songLength <= 0) return null;

  const bpm = song.bpm || 120;
  if (!projectAxis) return null;
  const projectLengthBeats = projectAxis.durationBeats(songLength);
  const pixelsPerBeat = viewport.pixelsPerBeat;
  const projectPixelsPerSecond = pixelsPerBeat * bpm / 60;
  const projectScrollPx = (regionStartBeats + viewport.scrollBeats) * viewport.pixelsPerBeat;
  const projectContentWidth = projectLengthBeats * pixelsPerBeat;
  const tsNum = song.tsNum || timeSignatureNumerator;
  const tsDen = song.tsDen || 4;
  const visibleWidth = Math.max(1, canvasWidth - viewport.keyWidth);

  return (
    <div
      className="pointer-events-none absolute top-0 z-20 h-9 overflow-hidden"
      style={{ left: viewport.keyWidth, right: 0 }}
    >
      <div className="relative h-full" style={{ left: -projectScrollPx, width: projectContentWidth }}>
        <Ruler
          layer="backdrop"
          pxPerSec={projectPixelsPerSecond}
          contentWidth={projectContentWidth}
          songLength={projectLengthBeats}
          bpm={bpm}
          tsNum={tsNum}
          scrollLeft={projectScrollPx}
          viewportWidth={visibleWidth}
          pixelsPerBeat={pixelsPerBeat}
          signaturePoints={song.signaturePoints}
          defaultDenominator={tsDen}
        />
        {onCycleToggleActive && onCycleSetRange && onCycleToggleSkip && (
          <CycleStrip
            song={song}
            songIndex={songIndex}
            songLength={songLength}
            pxPerSec={projectPixelsPerSecond}
            coordinatePixelsPerUnit={pixelsPerBeat}
            timeToCoordinate={projectAxis.secondsToBeats}
            coordinateToTime={projectAxis.beatsToSeconds}
            snapTime={(seconds) => snap > 0
              ? projectAxis.snapSeconds(seconds, snap)
              : seconds}
            cycle={cycle}
            ownsCycle={cycleOwner}
            bpm={bpm}
            tsNum={tsNum}
            snapToGrid={snap > 0}
            onToggleActive={onCycleToggleActive}
            onSetRange={onCycleSetRange}
            onToggleSkip={onCycleToggleSkip}
            onDragEnd={onCycleDragEnd}
          />
        )}
        <Ruler
          layer="labels"
          pxPerSec={projectPixelsPerSecond}
          contentWidth={projectContentWidth}
          songLength={projectLengthBeats}
          bpm={bpm}
          tsNum={tsNum}
          scrollLeft={projectScrollPx}
          viewportWidth={visibleWidth}
          pixelsPerBeat={pixelsPerBeat}
          signaturePoints={song.signaturePoints}
          defaultDenominator={tsDen}
        />
      </div>
    </div>
  );
}
