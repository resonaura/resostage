import { describe, expect, it } from "vitest";
import { resolveTrackSelection } from "@/screens/editor/timeline/tracks/logic/trackSelection";

describe("track selection gestures", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("selects a contiguous range from the anchor with Shift", () => {
    expect(
      resolveTrackSelection(
        { selectedIds: ["b"], primaryId: "b", anchorId: "b" },
        order,
        "e",
        "range",
      ),
    ).toEqual({
      selectedIds: ["b", "c", "d", "e"],
      primaryId: "e",
      anchorId: "b",
    });
  });

  it("toggles one row with Command or Control without expanding a range", () => {
    expect(
      resolveTrackSelection(
        { selectedIds: ["b", "d"], primaryId: "d", anchorId: "b" },
        order,
        "c",
        "toggle",
      ),
    ).toEqual({
      selectedIds: ["b", "d", "c"],
      primaryId: "c",
      anchorId: "b",
    });
  });
});
