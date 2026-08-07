import { describe, expect, it } from "vitest";

import {
  buildPeaksByFile,
  resolveRegionPeakEntry,
  type PeakEntry,
} from "./regionPeaks";
import type { RegionRow, SongRow } from "../../lib/types";

const region = (id: string, file: string, offset = 0): RegionRow =>
  ({
    id,
    trackId: "audio::track:1",
    startSeconds: 0,
    durationSeconds: 10,
    gainDb: 0,
    source: { file, offsetSeconds: offset },
  }) as unknown as RegionRow;

const song = (regions: RegionRow[]): SongRow =>
  ({ regions }) as unknown as SongRow;

const entry = (id: string, filled = true): PeakEntry => ({
  id,
  trackId: "audio::track:1",
  durationSeconds: 120,
  levels: filled
    ? [{ samplesPerBin: 256, min: [-1], max: [1], rms: [0.5] }]
    : [],
});

describe("resolveRegionPeakEntry", () => {
  it("prefers the region's own entry", () => {
    const regions = [region("a", "Audio/x.wav"), region("b", "Audio/y.wav")];
    const entries = [entry("a"), entry("b")];
    const byFile = buildPeaksByFile(song(regions), entries);

    expect(
      resolveRegionPeakEntry(regions[1], entries, byFile, "audio::track:1")?.id,
    ).toBe("b");
  });

  it("falls back to a sibling cut from the same file", () => {
    // The exact shape a split produces: the right half exists in the project
    // but the peak payload still only describes the pre-split region, because
    // the backend regenerates it on its own timer.
    const left = region("a", "Audio/x.wav");
    const right = region("split-new", "Audio/x.wav", 80);
    const stalePayload = [entry("a")];
    const byFile = buildPeaksByFile(song([left, right]), stalePayload);

    const resolved = resolveRegionPeakEntry(
      right,
      stalePayload,
      byFile,
      "audio::track:1",
    );
    expect(resolved?.id).toBe("a");
    expect(resolved?.levels.length).toBeGreaterThan(0);
  });

  it("does not borrow across different source files", () => {
    const regions = [region("a", "Audio/x.wav"), region("new", "Audio/y.wav")];
    const entries = [entry("a")];
    const byFile = buildPeaksByFile(song(regions), entries);

    expect(
      resolveRegionPeakEntry(regions[1], entries, byFile, "audio::track:1"),
    ).toBeUndefined();
  });

  it("ignores empty entries when indexing by file", () => {
    // An unbuilt entry carries the right id but no levels -- borrowing it
    // would swap one spinner for a blank waveform.
    const regions = [region("a", "Audio/x.wav"), region("new", "Audio/x.wav")];
    const entries = [entry("a", /*filled=*/ false)];
    const byFile = buildPeaksByFile(song(regions), entries);

    expect(byFile.size).toBe(0);
    expect(
      resolveRegionPeakEntry(regions[1], entries, byFile, "audio::track:1"),
    ).toBeUndefined();
  });

  it("uses track-id matching for the coarse per-song payload", () => {
    // The `peaks` fallback has no trackId field and is keyed by track.
    const r = region("a", "Audio/x.wav");
    const coarse: PeakEntry[] = [
      { id: "audio::track:1", durationSeconds: 120, levels: entry("x").levels },
    ];
    const byFile = buildPeaksByFile(song([r]), coarse);

    expect(
      resolveRegionPeakEntry(r, coarse, byFile, "audio::track:1")?.id,
    ).toBe("audio::track:1");
  });
});
