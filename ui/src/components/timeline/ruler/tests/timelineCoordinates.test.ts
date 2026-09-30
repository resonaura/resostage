import { describe, expect, it } from "vitest";
import type { SongRow } from "../../../../lib/state/types";
import {
  resolveTimelineSong,
  snapSongLocalSeconds,
  timelineSecondsAtClientX,
} from "../logic/timelineCoordinates";

const songs = [
  { bpm: 120, tsNum: 4 },
  { bpm: 60, tsNum: 3 },
] as SongRow[];

describe("timeline coordinate mapping", () => {
  it("resolves exact song boundaries to the following song", () => {
    expect(resolveTimelineSong(10, songs, [0, 10], [10, 8])).toEqual({
      songIndex: 1,
      localSeconds: 0,
    });
  });

  it("keeps overrun time local to the last song for the caller to clamp", () => {
    expect(resolveTimelineSong(22, songs, [0, 10], [10, 8])).toEqual({
      songIndex: 1,
      localSeconds: 12,
    });
  });

  it("returns no song for an empty project", () => {
    expect(resolveTimelineSong(0, [], [], [])).toEqual({
      songIndex: -1,
      localSeconds: 0,
    });
  });

  it("uses the scrolled body rect without adding scrollLeft again", () => {
    expect(timelineSecondsAtClientX(420, 120, 30)).toBe(10);
    expect(timelineSecondsAtClientX(80, 120, 30)).toBe(0);
  });

  it("snaps with the current song tempo and leaves free drags unchanged", () => {
    expect(snapSongLocalSeconds(songs[1], 0.6, 100, true)).toBe(0.75);
    expect(snapSongLocalSeconds(songs[1], 0.6, 100, false)).toBe(0.6);
    expect(snapSongLocalSeconds(undefined, 0.6, 100, true)).toBe(0.6);
  });
});
