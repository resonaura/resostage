import { describe, expect, it } from "vitest";
import type { RegionRow, SongRow, TrackRow } from "../../lib/types";
import { buildRows, songContentSeconds, songDurationSeconds } from "./rows";

const track = (id: string, name: string): TrackRow => ({
  id,
  name,
  channels: 1,
  gainDb: 0,
  pan: 0,
  mute: false,
  solo: false,
  soloGroup: "sources",
  soloActiveInGroup: false,
  output: { type: "main", sends: [] },
  peakDb: -100,
});

const region = (
  partial: Partial<RegionRow> & Pick<RegionRow, "id" | "trackId">,
): RegionRow => ({
  startSeconds: 0,
  durationSeconds: 4,
  gainDb: 0,
  source: { file: "a.wav", offsetSeconds: 0 },
  fade: { inSeconds: 0, outSeconds: 0 },
  ...partial,
});

const song = (partial: Partial<SongRow> & { name: string }): SongRow => ({
  bpm: 120,
  mode: "auto",
  tsNum: 4,
  tsDen: 4,
  click: false,
  clickBusId: "master",
  clickSends: [],
  tracks: [],
  events: [],
  regions: [],
  sections: [],
  ...partial,
});

describe("buildRows", () => {
  it("one row per staged track name", () => {
    const rows = buildRows(
      [track("t1", "Drums"), track("t2", "Bass")],
      [song({ name: "A" })],
    );
    expect(rows.map((r) => r.name)).toEqual(["Drums", "Bass"]);
    expect(rows[0].headerIndex).toBe(0);
    expect(rows[1].headerIndex).toBe(1);
  });

  it("adds orphan region track rows without a header index", () => {
    const rows = buildRows(
      [track("t1", "Drums")],
      [
        song({
          name: "A",
          regions: [region({ id: "r1", trackId: "ghost" })],
        }),
      ],
    );
    expect(rows.map((r) => r.name)).toEqual(["Drums", "ghost"]);
    expect(rows[1].headerIndex).toBeNull();
  });
});

describe("songDurationSeconds", () => {
  it("takes the max of regions, peaks, and events", () => {
    const s = song({
      name: "A",
      regions: [region({ id: "r1", trackId: "t1", durationSeconds: 10 })],
      events: [{ timeSeconds: 12 } as SongRow["events"][number]],
    });
    expect(songDurationSeconds(s, [{ id: "p", durationSeconds: 8 }])).toBe(12);
  });

  it("floors at 1 second", () => {
    expect(songDurationSeconds(song({ name: "empty" }), undefined)).toBe(1);
  });

  it("measures a region from where it starts, not just how long it is", () => {
    const s = song({
      name: "A",
      regions: [
        region({
          id: "r1",
          trackId: "t1",
          startSeconds: 60,
          durationSeconds: 30,
        }),
      ],
    });
    expect(songContentSeconds(s, undefined)).toBe(90);
  });

  it("an authored end wins over the content, longer or shorter", () => {
    const withContent = song({
      name: "A",
      regions: [region({ id: "r1", trackId: "t1", durationSeconds: 10 })],
    });
    // Room to write into, past everything currently in the song...
    expect(songDurationSeconds({ ...withContent, endSeconds: 240 }, undefined))
      .toBe(240);
    // ...and shorter than the content, which puts the tail out of bounds
    // rather than silently deleting it.
    expect(songDurationSeconds({ ...withContent, endSeconds: 4 }, undefined))
      .toBe(4);
  });

  it("gives an empty song a real length once one is authored", () => {
    // The case the end marker exists for: nothing in the song at all.
    expect(songDurationSeconds(song({ name: "empty", endSeconds: 120 }), undefined))
      .toBe(120);
  });

  it("treats a zero or negative end as 'derive from content'", () => {
    const s = song({
      name: "A",
      regions: [region({ id: "r1", trackId: "t1", durationSeconds: 10 })],
    });
    expect(songDurationSeconds({ ...s, endSeconds: 0 }, undefined)).toBe(10);
    expect(songDurationSeconds({ ...s, endSeconds: -5 }, undefined)).toBe(10);
  });
});
