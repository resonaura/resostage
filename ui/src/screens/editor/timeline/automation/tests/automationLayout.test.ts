/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  automationLaneCollapseKey,
  automationPseudoTrackHeightPx,
  automationTrackHeightPx,
  timelineRowIndexAtY,
  timelineRowTopPx,
  timelineRowsHeightPx,
} from "@/screens/editor/timeline/automation/logic/automationLayout";

describe("automation timeline row geometry", () => {
  it("keeps collapsed lanes compact and expanded lanes usable at every zoom", () => {
    for (const laneHeight of [22, 32, 56, 112]) {
      const expanded = automationPseudoTrackHeightPx(laneHeight, false);
      const collapsed = automationPseudoTrackHeightPx(laneHeight, true);
      expect(expanded).toBeGreaterThanOrEqual(36);
      expect(collapsed).toBeGreaterThanOrEqual(22);
      expect(expanded).toBeGreaterThan(collapsed);
    }
  });

  it("uses the same collapsed state when computing row heights and lane offsets", () => {
    const scope = "project:epoch:song";
    const keys = new Set([automationLaneCollapseKey(scope, "lane-b")]);
    const rowHeights = [
      automationTrackHeightPx(56, ["lane-a", "lane-b"], scope, keys),
      56,
    ];
    expect(rowHeights).toEqual([
      56 + automationPseudoTrackHeightPx(56, false) + automationPseudoTrackHeightPx(56, true),
      56,
    ]);
    expect(timelineRowsHeightPx(rowHeights)).toBe(rowHeights[0] + rowHeights[1]);
  });

  it("maps child pseudo-track hit areas to their parent track and respects row offsets", () => {
    const heights = [120, 56, 82];
    expect(timelineRowTopPx(2, heights)).toBe(176);
    expect(timelineRowIndexAtY(0, heights, 56)).toBe(0);
    expect(timelineRowIndexAtY(119, heights, 56)).toBe(0);
    expect(timelineRowIndexAtY(120, heights, 56)).toBe(1);
    expect(timelineRowIndexAtY(258, heights, 56)).toBe(2);
    expect(timelineRowIndexAtY(1000, heights, 56)).toBe(2);
  });
});
