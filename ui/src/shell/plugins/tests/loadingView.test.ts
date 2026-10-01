/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { pluginLoadingView } from "@/shell/plugins/logic/loadingView";
import type { PluginLoadingState } from "@/lib/state/types";

const base: PluginLoadingState = {
  epoch: 1, generation: 3, phase: "loading", blocksPlayback: true,
  showDialog: true, playRequested: false, total: 4, completed: 1,
  failed: 0, currentName: "Instrument", error: "",
};
describe("plug-in loading presentation", () => {
  it("never offers premature continuation or retry", () => {
    const view = pluginLoadingView(base, true);
    expect(view.pending).toBe(true);
    expect(view.canContinue).toBe(false);
    expect(view.canRetry).toBe(false);
    expect(view.completed).toBe(1);
  });
  it("allows an explicit degraded decision only with a live connection", () => {
    expect(pluginLoadingView({ ...base, phase: "degraded", failed: 1 }, true).canContinue).toBe(true);
    const disconnected = pluginLoadingView({ ...base, phase: "failed" }, false);
    expect(disconnected.canContinue).toBe(false);
    expect(disconnected.canRetry).toBe(false);
    expect(disconnected.description).toContain("reconnection");
  });
  it("bounds progress and avoids a zero denominator", () => {
    const view = pluginLoadingView({ ...base, total: 0, completed: 999 }, true);
    expect(view.total).toBe(1);
    expect(view.completed).toBe(0);
  });
});
