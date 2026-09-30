import { describe, expect, it } from "vitest";
import { previewDropReorder } from "../logic/dropPreview";

describe("previewDropReorder", () => {
  it("previews forward movement using the pre-removal drop slot", () => {
    const items = ["a", "b", "c", "d"];
    expect(previewDropReorder(items, 1, 4)).toEqual(["a", "c", "d", "b"]);
    expect(items).toEqual(["a", "b", "c", "d"]);
  });

  it("previews backward movement", () => {
    expect(previewDropReorder(["a", "b", "c", "d"], 3, 1)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("preserves the input reference for invalid or unchanged drops", () => {
    const items = ["a", "b"];
    expect(previewDropReorder(items, 1, 1)).toBe(items);
    expect(previewDropReorder(items, -1, 0)).toBe(items);
    expect(previewDropReorder(items, items.length, 0)).toBe(items);
  });
});
