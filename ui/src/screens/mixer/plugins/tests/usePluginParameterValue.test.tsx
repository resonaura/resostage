/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginParameterValues, PluginSlotRow } from "@/lib/state/types";
import { PluginParameterValueReadout } from "@/screens/mixer/plugins/components/PluginParameterValueReadout";

const { parameterValues } = vi.hoisted(() => ({ parameterValues: vi.fn() }));

vi.mock("@/lib/state/api", () => ({
  pluginChains: { parameterValues },
}));

import { usePluginParameterValue } from "@/screens/mixer/plugins/hooks/usePluginParameterValue";

const loadedSlot: Pick<PluginSlotRow, "id" | "pluginId" | "loadState"> = {
  id: "slot-a",
  pluginId: "vendor:synth",
  loadState: "loaded",
};

const response = (slotId: string, index: number, value: number): PluginParameterValues => ({
  slotId,
  values: [{ index, value }],
  loadState: "loaded",
  loadError: "",
});

function Harness({
  enabled = true,
  slot = loadedSlot,
  parameterIndex = 7,
  valueIdentity = "session:1:3",
}: {
  enabled?: boolean;
  slot?: typeof loadedSlot | null;
  parameterIndex?: number | null;
  valueIdentity?: string;
}) {
  const snapshot = usePluginParameterValue({ enabled, slot, parameterIndex, valueIdentity });
  return createElement("output", {
    "data-state": snapshot.state,
    "data-value": snapshot.value === null ? "" : String(snapshot.value),
    "data-error": snapshot.error,
  });
}

describe("usePluginParameterValue", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    parameterValues.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("samples only the selected parameter and keeps one bounded poll in flight", async () => {
    parameterValues
      .mockResolvedValueOnce(response("slot-a", 7, 0.25))
      .mockResolvedValueOnce(response("slot-a", 7, 0.8));

    await act(async () => root.render(createElement(Harness)));
    expect(container.firstElementChild?.getAttribute("data-state")).toBe("loaded");
    expect(container.firstElementChild?.getAttribute("data-value")).toBe("0.25");
    expect(parameterValues).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(container.firstElementChild?.getAttribute("data-value")).toBe("0.8");
    expect(parameterValues).toHaveBeenCalledTimes(2);
    expect(parameterValues).toHaveBeenNthCalledWith(1, "slot-a");
    expect(parameterValues).toHaveBeenNthCalledWith(2, "slot-a");
  });

  it("does not poll while hidden or while a plug-in is not loaded", async () => {
    await act(async () => root.render(createElement(Harness, { enabled: false })));
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(parameterValues).not.toHaveBeenCalled();

    const loadingSlot = { ...loadedSlot, loadState: "loading" as const };
    await act(async () => root.render(createElement(Harness, { slot: loadingSlot })));
    expect(parameterValues).not.toHaveBeenCalled();
  });

  it("ignores a late value response after the selected slot changes", async () => {
    let resolveOld!: (value: PluginParameterValues) => void;
    parameterValues
      .mockImplementationOnce(() => new Promise<PluginParameterValues>((resolve) => {
        resolveOld = resolve;
      }))
      .mockResolvedValueOnce(response("slot-b", 7, 0.6));

    await act(async () => root.render(createElement(Harness)));
    const nextSlot = { ...loadedSlot, id: "slot-b", pluginId: "vendor:other" };
    await act(async () => root.render(createElement(Harness, { slot: nextSlot })));
    expect(container.firstElementChild?.getAttribute("data-value")).toBe("0.6");

    await act(async () => {
      resolveOld(response("slot-a", 7, 0.95));
      await Promise.resolve();
    });
    expect(container.firstElementChild?.getAttribute("data-value")).toBe("0.6");
    expect(parameterValues).toHaveBeenCalledTimes(2);
  });

  it("fences a late response from the previous Core project identity", async () => {
    let resolveOld!: (value: PluginParameterValues) => void;
    parameterValues
      .mockImplementationOnce(() => new Promise<PluginParameterValues>((resolve) => {
        resolveOld = resolve;
      }))
      .mockResolvedValueOnce(response("slot-a", 7, 0.6));

    await act(async () => root.render(createElement(Harness)));
    await act(async () => root.render(createElement(Harness, {
      valueIdentity: "new-session:2:4",
    })));
    expect(container.firstElementChild?.getAttribute("data-value")).toBe("0.6");

    await act(async () => {
      resolveOld(response("slot-a", 7, 0.95));
      await Promise.resolve();
    });
    expect(container.firstElementChild?.getAttribute("data-value")).toBe("0.6");
    expect(parameterValues).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a disappeared parameter from a zero-valued parameter", async () => {
    parameterValues.mockResolvedValueOnce(response("slot-a", 6, 0.4));
    await act(async () => root.render(createElement(Harness)));
    expect(container.firstElementChild?.getAttribute("data-state")).toBe("unbound");
    expect(container.firstElementChild?.getAttribute("data-value")).toBe("");
  });

  it("renders the live parameter value as a normalized percentage", async () => {
    parameterValues.mockResolvedValueOnce(response("slot-a", 7, 0.75));
    await act(async () => root.render(createElement(PluginParameterValueReadout, {
      enabled: true,
      slot: loadedSlot,
      parameter: { index: 7, name: "Cutoff" },
      valueIdentity: "session:1:3",
    })));

    expect(container.querySelector("output")?.textContent).toBe("75.0%");
    expect(container.querySelector("output")?.getAttribute("aria-label"))
      .toBe("Cutoff current normalized value");
  });
});
