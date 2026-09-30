import type { AllPeaksResponse, PeaksResponse, WebUiState, SongRow } from "@/lib/state/types";
import {
  AUDIO_HINT_HEIGHT,
} from "@/screens/editor/timeline/layout/logic/hintStripDimensions";
import {
  COMPACT_LANE_MAX_PX,
  LANE_HEIGHT,
} from "@/screens/editor/timeline/layout/logic/laneDimensions";
import { buildSongPeakLookup } from "@/screens/editor/timeline/regions/logic/regionPeaks";
import { TrackWaveformLane } from "@/screens/editor/timeline/waveform/components/TrackWaveformLane";

// Light mode: a dimmed, non-interactive waveform strip so the light-focused
// view keeps its musical reference. Reuses the real waveform renderer
// (TrackWaveformLane) per region, stacked over one short strip.
//
// The strip is FIXED height (AUDIO_HINT_HEIGHT) — it does not track the
// timeline's vertical zoom. Waveform verticalZoom is therefore a constant
// sized to fill the strip and always stay above the compact-lane cutoff
// (below which TrackWaveformLane draws nothing).
const AUDIO_HINT_WAVEFORM_ZOOM = Math.max(
  (COMPACT_LANE_MAX_PX + 2) / LANE_HEIGHT,
  AUDIO_HINT_HEIGHT / LANE_HEIGHT,
);

export function AudioHintStrip({
  state,
  peaks,
  allPeaks,
  audioRows,
  songs,
  songOffsets,
  songLengths,
  pxPerSec,
  scrollState,
  contentWidth,
}: {
  state: WebUiState;
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  audioRows: { name: string; color: string }[];
  songs: SongRow[];
  songOffsets: number[];
  songLengths: number[];
  pxPerSec: number;
  scrollState: { scrollLeft: number; viewportWidth: number };
  /** @deprecated ignored — strip height is fixed; kept optional for callers. */
  verticalZoom?: number;
  contentWidth: number;
}) {
  const viewStart = scrollState.scrollLeft;
  const viewEnd = scrollState.scrollLeft + scrollState.viewportWidth;
  return (
    <div
      className="pointer-events-none relative shrink-0 overflow-hidden border-b border-default/30 bg-default/10"
      style={{ width: contentWidth, height: AUDIO_HINT_HEIGHT }}
    >
      {songs.map((song, i) => {
        const segStart = songOffsets[i] * pxPerSec;
        const segEnd = segStart + songLengths[i] * pxPerSec;
        if (viewEnd <= segStart || viewStart >= segEnd) return null;
        const peakLookup = buildSongPeakLookup(
          allPeaks?.songs[i]?.tracks,
          allPeaks?.files,
          i === state.songIndex ? peaks?.tracks : undefined,
        );
        const segDuration = songLengths[i];
        return (
          <div
            key={i}
            className="absolute top-0 bottom-0"
            style={{ left: segStart, width: songLengths[i] * pxPerSec }}
          >
            {audioRows.map((row) => {
              const track = state.tracks.find(
                (candidate) => (candidate.name || candidate.id) === row.name || candidate.id === row.name,
              );
              return (song.regions ?? [])
                .filter(
                  (region) =>
                    Boolean(region.source.file) &&
                    (region.trackId === track?.id || region.trackId === row.name),
                )
                .map((region) => {
                  const peakEntry = peakLookup.forRegion(region, track?.id);
                  const fileDuration =
                    peakEntry?.durationSeconds ??
                    region.durationSeconds ??
                    segDuration;
                  const duration =
                    region.durationSeconds > 0
                      ? region.durationSeconds
                      : Math.max(0.05, segDuration - region.startSeconds);
                  const leftPx = region.startSeconds * pxPerSec;
                  const widthPx = Math.max(4, duration * pxPerSec);
                  if (
                    leftPx + widthPx < viewStart - segStart ||
                    leftPx > viewEnd - segStart
                  )
                    return null;
                  const absLeft = segStart + leftPx;
                  const regViewStart = Math.max(absLeft, viewStart);
                  const regViewEnd = Math.min(absLeft + widthPx, viewEnd);
                  const regViewportWidth = Math.max(0, regViewEnd - regViewStart);
                  if (regViewportWidth <= 0) return null;
                  return (
                    <div
                      key={region.id}
                      className="absolute top-0 bottom-0"
                      style={{ left: leftPx, width: widthPx, opacity: 0.28 }}
                    >
                      <TrackWaveformLane
                        levels={peakEntry?.levels ?? []}
                        durationSeconds={fileDuration}
                        regionFile={region.source.file}
                        gestureActive={false}
                        verticalZoom={AUDIO_HINT_WAVEFORM_ZOOM}
                        contentWidth={widthPx}
                        scrollLeft={Math.max(0, regViewStart - absLeft)}
                        viewportWidth={regViewportWidth}
                        pxPerSec={pxPerSec}
                        color={row.color}
                        muted={false}
                        sourceOffsetSec={region.source.offsetSeconds}
                        embedded
                      />
                    </div>
                  );
                });
            })}
          </div>
        );
      })}
    </div>
  );
}
