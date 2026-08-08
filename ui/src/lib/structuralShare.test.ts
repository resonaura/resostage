import { describe, expect, it } from "vitest";
import { shareStructure } from "./structuralShare";

describe("shareStructure", () => {
  it("returns the previous graph when nothing changed", () => {
    const prev = { songs: [{ name: "A", regions: [{ id: "r1" }] }], playhead: 1 };
    const next = { songs: [{ name: "A", regions: [{ id: "r1" }] }], playhead: 1 };
    expect(shareStructure(prev, next)).toBe(prev);
  });

  it("keeps unchanged branches while replacing changed ones", () => {
    const prev = {
      playheadSeconds: 1,
      songs: [{ name: "A" }, { name: "B" }],
      lighting: { fixtures: [{ id: "f1" }] },
    };
    const next = {
      playheadSeconds: 2,
      songs: [{ name: "A" }, { name: "B" }],
      lighting: { fixtures: [{ id: "f1" }] },
    };
    const shared = shareStructure(prev, next);

    // Only the scalar moved, so only the root is new.
    expect(shared).not.toBe(prev);
    expect(shared.playheadSeconds).toBe(2);
    // These are the references memoized panels and effects key off.
    expect(shared.songs).toBe(prev.songs);
    expect(shared.lighting).toBe(prev.lighting);
  });

  it("shares siblings when one array element changes", () => {
    const prev = { songs: [{ name: "A" }, { name: "B" }] };
    const next = { songs: [{ name: "A" }, { name: "B-renamed" }] };
    const shared = shareStructure(prev, next);

    expect(shared.songs).not.toBe(prev.songs);
    expect(shared.songs[0]).toBe(prev.songs[0]);
    expect(shared.songs[1]).toEqual({ name: "B-renamed" });
  });

  it("shares surviving elements when the array grows", () => {
    const prev = { regions: [{ id: "r1" }, { id: "r2" }] };
    const next = { regions: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] };
    const shared = shareStructure(prev, next);

    expect(shared.regions).toHaveLength(3);
    expect(shared.regions[0]).toBe(prev.regions[0]);
    expect(shared.regions[1]).toBe(prev.regions[1]);
  });

  it("does not confuse a shorter array for an equal one", () => {
    const prev = { regions: [{ id: "r1" }, { id: "r2" }] };
    const next = { regions: [{ id: "r1" }] };
    const shared = shareStructure(prev, next);

    expect(shared.regions).toHaveLength(1);
    expect(shared.regions).not.toBe(prev.regions);
  });

  it("treats a removed key as a change", () => {
    const prev = { a: 1, b: 2 };
    const next = { a: 1 } as { a: number; b?: number };
    expect(shareStructure(prev, next)).not.toBe(prev);
  });

  it("passes primitives and nulls through untouched", () => {
    expect(shareStructure(1, 2)).toBe(2);
    expect(shareStructure({ a: 1 }, null)).toBe(null);
    expect(shareStructure(null, { a: 1 })).toEqual({ a: 1 });
    // An array replacing an object (or vice versa) is never "the same shape".
    expect(shareStructure({ 0: "a" }, ["a"])).toEqual(["a"]);
  });
});
