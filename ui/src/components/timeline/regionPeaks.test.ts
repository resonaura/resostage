import { describe, expect, it } from "vitest";

import { buildSongPeakLookup } from "./regionPeaks";
import type {
  AllPeaksResponse,
  PeakLevelData,
  RegionRow,
  TrackPeaks,
} from "../../lib/types";

const LEVELS: PeakLevelData[] = [
  { samplesPerBin: 256, min: [-1], max: [1], rms: [0.5] },
];

const region = (id: string, file: string, offset = 0): RegionRow =>
  ({
    id,
    trackId: "audio::track:1",
    startSeconds: 0,
    durationSeconds: 10,
    gainDb: 0,
    source: { file, offsetSeconds: offset },
  }) as unknown as RegionRow;

const fileEntry = (
  file: string,
  filled = true,
): AllPeaksResponse["files"][number] => ({
  file,
  durationSeconds: 120,
  levels: filled ? LEVELS : [],
});

const regionEntry = (
  id: string,
  levelsIndex: number,
): AllPeaksResponse["songs"][number]["tracks"][number] => ({
  id,
  trackId: "audio::track:1",
  durationSeconds: 120,
  levelsIndex,
});

describe("buildSongPeakLookup", () => {
  it("dereferences a region's own entry through the shared file table", () => {
    const lookup = buildSongPeakLookup(
      [regionEntry("a", 0), regionEntry("b", 1)],
      [fileEntry("Audio/x.wav"), fileEntry("Audio/y.wav")],
      undefined,
    );

    const resolved = lookup.forRegion(
      region("b", "Audio/y.wav"),
      "audio::track:1",
    );
    expect(resolved?.levels).toBe(LEVELS);
    expect(resolved?.durationSeconds).toBe(120);
  });

  it("resolves a region the payload has not caught up with, by file", () => {
    // Exactly what a split produces: the right half exists in the project but
    // the payload still only lists the pre-split region, because the backend
    // regenerates it on its own timer. Its file is already in the table.
    const lookup = buildSongPeakLookup(
      [regionEntry("a", 0)],
      [fileEntry("Audio/x.wav")],
      undefined,
    );

    const resolved = lookup.forRegion(
      region("split-new", "Audio/x.wav", 80),
      "audio::track:1",
    );
    expect(resolved?.levels).toBe(LEVELS);
  });

  it("does not borrow across different source files", () => {
    const lookup = buildSongPeakLookup(
      [regionEntry("a", 0)],
      [fileEntry("Audio/x.wav")],
      undefined,
    );

    expect(
      lookup.forRegion(region("new", "Audio/y.wav"), "audio::track:1"),
    ).toBeUndefined();
  });

  it("treats an unbuilt file entry as no peaks rather than a blank waveform", () => {
    const lookup = buildSongPeakLookup(
      [regionEntry("a", 0)],
      [fileEntry("Audio/x.wav", /*filled=*/ false)],
      undefined,
    );

    expect(
      lookup.forRegion(region("a", "Audio/x.wav"), "audio::track:1"),
    ).toBeUndefined();
  });

  it("treats levelsIndex -1 as not built yet", () => {
    const lookup = buildSongPeakLookup([regionEntry("a", -1)], [], undefined);

    expect(
      lookup.forRegion(region("a", "Audio/x.wav"), "audio::track:1"),
    ).toBeUndefined();
  });

  it("falls back to the coarse per-track payload for the staged song", () => {
    const coarse: TrackPeaks[] = [
      { id: "audio::track:1", durationSeconds: 90, levels: LEVELS },
    ];
    const lookup = buildSongPeakLookup(undefined, undefined, coarse);

    const resolved = lookup.forRegion(
      region("a", "Audio/x.wav"),
      "audio::track:1",
    );
    expect(resolved?.durationSeconds).toBe(90);
    expect(resolved?.levels).toBe(LEVELS);
  });
});
