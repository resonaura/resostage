/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginChains } from "@/lib/state/api";
import type { PluginParameterList, PluginParameterValues, TrackRow } from "@/lib/state/types";
import { pluginParameterKey } from "@/screens/editor/timeline/automation/logic/pluginParameterIdentity";
import { useAutomationParameters } from "../useAutomationParameters";

vi.mock("@/lib/state/api", () => ({
  pluginChains: {
    parameters: vi.fn(),
    parameterValues: vi.fn(),
  },
}));

describe("useAutomationParameters", () => {
  let root: Root;
  let container: HTMLDivElement;
  let latest: ReturnType<typeof useAutomationParameters>;

  const track = (
    loadState: "loading" | "loaded" | "missing" | "failed" = "loaded",
    trackId = "track-1",
    slotId = "slot-1",
  ) => ({
    id: trackId,
    plugins: [{ id: slotId, pluginId: "vendor:compressor", loadState }],
  }) as unknown as TrackRow;

  const metadata = (
    loadState: PluginParameterList["loadState"] = "loaded",
    stripId = "track-1",
    slotId = "slot-1",
  ): PluginParameterList => ({
    stripId,
    slotId,
    loadState,
    loadError: "",
    truncated: false,
    parameters: [{ index: 4, parameterId: "id:threshold", name: "Threshold", label: "dB",
      defaultValue: 0.5, currentValue: 0.2, steps: 0, automatable: true }],
  });

  const values = (value: number, stripId = "track-1", slotId = "slot-1"): PluginParameterValues => ({
    stripId,
    slotId,
    loadState: "loaded",
    loadError: "",
    values: [{ index: 4, value }],
  });

  function Harness({ tracks, enabled, projectKey }: {
    tracks: TrackRow[];
    enabled: boolean;
    projectKey: string;
  }) {
    latest = useAutomationParameters(tracks, enabled, projectKey);
    return createElement("div");
  }

  async function render(tracks: TrackRow[], enabled = true, projectKey = crypto.randomUUID()) {
    await act(async () => {
      root.render(createElement(Harness, { tracks, enabled, projectKey }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    return projectKey;
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.useFakeTimers();
    vi.mocked(pluginChains.parameters).mockReset();
    vi.mocked(pluginChains.parameterValues).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("caches immutable descriptors and refreshes only compact current values", async () => {
    vi.mocked(pluginChains.parameters).mockResolvedValue(metadata());
    vi.mocked(pluginChains.parameterValues)
      .mockResolvedValueOnce(values(0.2))
      .mockResolvedValueOnce(values(0.8));

    const projectKey = await render([track()]);
    expect(pluginChains.parameters).toHaveBeenCalledWith("track-1", "slot-1");
    expect(pluginChains.parameterValues).toHaveBeenCalledWith("track-1", "slot-1");
    expect(pluginChains.parameters).toHaveBeenCalledTimes(1);
    expect(pluginChains.parameterValues).toHaveBeenCalledTimes(1);
    expect(latest[pluginParameterKey("track-1", "slot-1")].parameters[0].currentValue).toBe(0.2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(pluginChains.parameters).toHaveBeenCalledTimes(1);
    expect(pluginChains.parameterValues).toHaveBeenCalledTimes(2);
    expect(latest[pluginParameterKey("track-1", "slot-1")].parameters[0].currentValue).toBe(0.8);

    await render([track()], true, `${projectKey}:new-plugin-generation`);
    expect(pluginChains.parameters).toHaveBeenCalledTimes(2);
  });

  it("keeps the rendered snapshot stable when refreshed values are unchanged", async () => {
    vi.mocked(pluginChains.parameters).mockResolvedValue(metadata());
    vi.mocked(pluginChains.parameterValues).mockResolvedValue(values(0.2));

    await render([track()]);
    const previousSnapshot = latest;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(pluginChains.parameterValues).toHaveBeenCalledTimes(2);
    expect(latest).toBe(previousSnapshot);
  });

  it("retries metadata while a plug-in is loading, then stops metadata polling", async () => {
    vi.mocked(pluginChains.parameters)
      .mockResolvedValueOnce(metadata("loading"))
      .mockResolvedValueOnce(metadata());
    vi.mocked(pluginChains.parameterValues).mockResolvedValue(values(0.4));

    await render([track("loading")]);
    expect(pluginChains.parameters).toHaveBeenCalledTimes(1);
    expect(latest[pluginParameterKey("track-1", "slot-1")]).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(pluginChains.parameters).toHaveBeenCalledTimes(2);
    expect(pluginChains.parameterValues).toHaveBeenCalledTimes(1);
    expect(latest[pluginParameterKey("track-1", "slot-1")].parameters[0].currentValue).toBe(0.4);
  });

  it("keeps duplicate slot IDs isolated by strip and prevents ambiguous automation targets", async () => {
    vi.mocked(pluginChains.parameters).mockImplementation(async (stripId) => metadata("loaded", stripId));
    vi.mocked(pluginChains.parameterValues).mockImplementation(async (stripId) =>
      values(stripId === "track-1" ? 0.2 : 0.8, stripId));

    await render([track(), track("loaded", "track-2")]);

    const first = latest[pluginParameterKey("track-1", "slot-1")];
    const second = latest[pluginParameterKey("track-2", "slot-1")];
    expect(pluginChains.parameters).toHaveBeenNthCalledWith(1, "track-1", "slot-1");
    expect(pluginChains.parameters).toHaveBeenNthCalledWith(2, "track-2", "slot-1");
    expect(first.parameters[0].currentValue).toBe(0.2);
    expect(second.parameters[0].currentValue).toBe(0.8);
    expect(first.scopeAmbiguous).toBe(true);
    expect(second.scopeAmbiguous).toBe(true);
  });

  it("rejects a parameter catalog returned for another strip", async () => {
    vi.mocked(pluginChains.parameters).mockResolvedValue(metadata("loaded", "other-track"));

    await render([track()]);

    const result = latest[pluginParameterKey("track-1", "slot-1")];
    expect(result.loadState).toBe("failed");
    expect(result.loadError).toContain("expected strip");
    expect(pluginChains.parameterValues).not.toHaveBeenCalled();
  });

  it("retries an unscoped legacy response if duplicate IDs later become unique", async () => {
    const unscoped = metadata();
    delete unscoped.stripId;
    vi.mocked(pluginChains.parameters).mockResolvedValue(unscoped);
    vi.mocked(pluginChains.parameterValues).mockResolvedValue(values(0.4));

    const projectKey = await render([track(), track("loaded", "track-2")]);
    expect(latest[pluginParameterKey("track-1", "slot-1")].loadState).toBe("failed");
    expect(pluginChains.parameterValues).not.toHaveBeenCalled();

    await render([track()], true, projectKey);
    expect(pluginChains.parameters).toHaveBeenCalledTimes(3);
    expect(latest[pluginParameterKey("track-1", "slot-1")].loadState).toBe("loaded");
    expect(latest[pluginParameterKey("track-1", "slot-1")].parameters[0].currentValue).toBe(0.4);
  });

  it("does not request plug-in metadata while the automation surface is hidden", async () => {
    await render([track()], false);
    expect(pluginChains.parameters).not.toHaveBeenCalled();
    expect(pluginChains.parameterValues).not.toHaveBeenCalled();
  });
});
