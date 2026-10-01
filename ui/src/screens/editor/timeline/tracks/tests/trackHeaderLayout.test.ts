import { describe, expect, it } from "vitest";
import { getTrackHeaderLayout } from "@/screens/editor/timeline/tracks/logic/trackHeaderLayout";

describe("track header density layout", () => {
  it("uses the combined volume and meter row at normal zoom", () => {
    expect(getTrackHeaderLayout(1)).toMatchObject({
      height: 56,
      showVolume: true,
      showPan: true,
      showMeter: false,
      buttonSize: 18,
      faderHeight: 12,
    });
  });

  it("keeps minimum-height controls compact and enables the meter above its threshold", () => {
    expect(getTrackHeaderLayout(0)).toMatchObject({
      height: 22,
      showVolume: false,
      showPan: false,
      showMeter: false,
      verticalPadding: 2,
      horizontalPadding: 6,
      buttonSize: 16,
      swatchHeight: 10,
      swatchWidth: 5,
    });
    expect(getTrackHeaderLayout(0.5)).toMatchObject({
      height: 28,
      showMeter: true,
    });
  });

  it("keeps control size transitions at their original lane-height thresholds", () => {
    expect(getTrackHeaderLayout(32 / 56)).toMatchObject({
      height: 32,
      showVolume: false,
      showPan: false,
      showMeter: true,
      nameSize: 12,
      verticalPadding: 3,
    });
    expect(getTrackHeaderLayout(48 / 56)).toMatchObject({
      height: 48,
      showVolume: true,
      showPan: true,
      showMeter: false,
    });
    expect(getTrackHeaderLayout(64 / 56)).toMatchObject({
      height: 64,
      buttonSize: 20,
      faderHeight: 14,
      swatchHeight: 14,
    });
  });
});
