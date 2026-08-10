import { describe, expect, it } from "vitest";
import type { SongRow } from "../../lib/types";
import { crossedDetent, edgesCrossedDetent, songDetents } from "./detents";

const song = {
  regions: [
    { id: "a", trackId: "t1", startSeconds: 4, durationSeconds: 2 },
    { id: "b", trackId: "t2", startSeconds: 10, durationSeconds: 0 },
  ],
  sections: [{ id: "s1", startSeconds: 8 }],
} as unknown as SongRow;

describe("songDetents", () => {
  it("collects region edges, sections, the cycle and both song ends", () => {
    expect(
      songDetents(song, 0, {
        songLength: 20,
        cycle: { songIndex: 0, leftSec: 12, rightSec: 16 },
      }),
    ).toEqual([0, 4, 6, 8, 10, 12, 16, 20]);
  });

  it("leaves out the thing being dragged", () => {
    const d = songDetents(song, 0, { excludeRegionId: "a" });
    expect(d).not.toContain(4);
    expect(d).toContain(10);
  });

  it("ignores a cycle that belongs to another song", () => {
    const d = songDetents(song, 1, {
      cycle: { songIndex: 0, leftSec: 12, rightSec: 16 },
    });
    expect(d).not.toContain(12);
  });

  it("keeps only the regions on one track when asked", () => {
    expect(songDetents(song, 0, { trackId: "t1" })).toEqual([0, 4, 6, 8]);
  });

  it("drops a zero duration rather than inventing an edge", () => {
    // durationSeconds 0 means "runs to the end of the song" -- the end is not
    // known here, and 10+0 would be a landmark on top of the start.
    expect(songDetents(song, 0)).toEqual([0, 4, 6, 8, 10]);
  });
});

describe("crossedDetent", () => {
  const d = [0, 4, 6, 10];

  it("ticks when a landmark is passed in either direction", () => {
    expect(crossedDetent(3.9, 4.1, d)).toBe(true);
    expect(crossedDetent(4.1, 3.9, d)).toBe(true);
  });

  it("stays quiet between landmarks", () => {
    expect(crossedDetent(4.2, 5.8, d)).toBe(false);
  });

  it("ticks once on arrival, not again on departure", () => {
    expect(crossedDetent(3.9, 4, d)).toBe(true);
    expect(crossedDetent(4, 4.1, d)).toBe(false);
  });

  it("ticks once for a jump that clears several", () => {
    expect(crossedDetent(1, 11, d)).toBe(true);
  });

  it("says nothing happened when nothing moved", () => {
    expect(crossedDetent(4, 4, d)).toBe(false);
    expect(crossedDetent(1, 2, [])).toBe(false);
  });
});

describe("edgesCrossedDetent", () => {
  it("ticks when any edge crosses", () => {
    // Region moved 5.0..7.0 -> 5.2..7.2: the start crossed nothing, the end
    // crossed the landmark at 7.1.
    expect(edgesCrossedDetent([5, 7], [5.2, 7.2], [7.1])).toBe(true);
    expect(edgesCrossedDetent([5, 7], [5.2, 7.2], [8])).toBe(false);
  });
});
