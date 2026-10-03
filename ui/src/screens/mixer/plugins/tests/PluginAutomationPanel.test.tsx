/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginParameterList,
  PluginParameterValues,
  PluginSlotRow,
  SongRow,
} from "@/lib/state/types";

const { parameters, parameterValues } = vi.hoisted(() => ({
  parameters: vi.fn(),
  parameterValues: vi.fn(),
}));

vi.mock("@/lib/state/api", () => ({
  builder: { automationLaneAdd: vi.fn(), automationLaneRemove: vi.fn() },
  pluginChains: { parameters, parameterValues },
}));

vi.mock("@/components/ui", () => ({
  Button: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, children),
}));

vi.mock("@/screens/mixer/plugins/components/AutomationMiniGraph", () => ({
  AutomationMiniGraph: () => null,
}));

import { PluginAutomationPanel } from "@/screens/mixer/plugins/components/PluginAutomationPanel";

const slots = [
  { id: "slot-a", pluginId: "vendor:a", name: "Plug-in A", loadState: "loaded" },
  { id: "slot-b", pluginId: "vendor:b", name: "Plug-in B", loadState: "loaded" },
] as PluginSlotRow[];
const song = { automationLanes: [] } as unknown as SongRow;

function parameterList(
  slotId: string,
  descriptors: PluginParameterList["parameters"],
): PluginParameterList {
  return {
    slotId,
    loadState: "loaded",
    loadError: "",
    truncated: false,
    parameters: descriptors,
  };
}

function loadingParameterList(slotId: string): PluginParameterList {
  return {
    slotId,
    loadState: "loading",
    loadError: "",
    truncated: false,
    parameters: [],
  };
}

function parameterValueList(
  slotId: string,
  index: number,
  value = 0.75,
): PluginParameterValues {
  return {
    slotId,
    loadState: "loaded",
    loadError: "",
    values: [{ index, value }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("PluginAutomationPanel parameter identity", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    parameters.mockReset();
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

  const render = (valueIdentity = "session:1:1", visible = true) =>
    createElement(PluginAutomationPanel, {
      visible,
      slots,
      song,
      songIndex: 0,
      valueIdentity,
    });

  it("offers only parameters explicitly marked automatable", async () => {
    parameters.mockResolvedValue(parameterList("slot-a", [
      {
        index: 1,
        parameterId: "id:read-only",
        name: "Read only",
        label: "",
        defaultValue: 0.5,
        currentValue: 0.5,
        steps: 0,
        automatable: false,
      },
      {
        index: 2,
        parameterId: "id:automatable",
        name: "Automatable",
        label: "",
        defaultValue: 0.5,
        currentValue: 0.5,
        steps: 0,
        automatable: true,
      },
    ]));
    parameterValues.mockResolvedValue(parameterValueList("slot-a", 2));

    await act(async () => root.render(render()));

    expect(container.textContent).toContain("Automatable");
    expect(container.textContent).not.toContain("Read only");
    expect(parameterValues).toHaveBeenCalledWith("slot-a");
  });

  it("waits for the isolated host and retries parameter discovery while visible", async () => {
    parameters
      .mockResolvedValueOnce(loadingParameterList("slot-a"))
      .mockResolvedValueOnce(parameterList("slot-a", [{
        index: 4,
        parameterId: "id:ready",
        name: "Ready parameter",
        label: "",
        defaultValue: 0.25,
        currentValue: 0.25,
        steps: 0,
        automatable: true,
      }]));
    parameterValues.mockResolvedValue(parameterValueList("slot-a", 4));

    await act(async () => root.render(render()));
    expect(container.textContent).toContain("Loading plug-in parameters");
    expect(parameters).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(container.textContent).toContain("Ready parameter");
    expect(parameters).toHaveBeenCalledTimes(2);
    expect(parameterValues).toHaveBeenCalledWith("slot-a");
  });

  it("does not discover plug-in parameters while its panel is hidden", async () => {
    parameters.mockResolvedValue(parameterList("slot-a", []));

    await act(async () => root.render(render("session:1:1", false)));
    expect(parameters).not.toHaveBeenCalled();

    await act(async () => root.render(render("session:1:1", true)));
    expect(parameters).toHaveBeenCalledWith("slot-a");
  });

  it("does not poll a newly selected slot using the old slot's parameter list", async () => {
    const oldCatalog = deferred<PluginParameterList>();
    const newCatalog = deferred<PluginParameterList>();
    parameters.mockImplementation((slotId: string) =>
      slotId === "slot-a" ? oldCatalog.promise : newCatalog.promise,
    );
    parameterValues.mockResolvedValue(parameterValueList("slot-b", 17));

    await act(async () => root.render(render()));
    expect(parameters).toHaveBeenCalledWith("slot-a");

    const selector = container.querySelector("select");
    expect(selector).not.toBeNull();
    await act(async () => {
      selector!.value = "slot-b";
      selector!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(parameters).toHaveBeenCalledWith("slot-b");

    await act(async () => {
      oldCatalog.resolve(parameterList("slot-a", [{
        index: 2,
        parameterId: "id:old",
        name: "Old parameter",
        label: "",
        defaultValue: 0.5,
        currentValue: 0.5,
        steps: 0,
        automatable: true,
      }]));
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Old parameter");
    expect(parameterValues).not.toHaveBeenCalled();

    await act(async () => {
      newCatalog.resolve(parameterList("slot-b", [{
        index: 17,
        parameterId: "id:new",
        name: "New parameter",
        label: "",
        defaultValue: 0.25,
        currentValue: 0.25,
        steps: 0,
        automatable: true,
      }]));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("New parameter");
    expect(parameterValues).toHaveBeenCalledTimes(1);
    expect(parameterValues).toHaveBeenCalledWith("slot-b");
  });
});
