/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement, type ChangeEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builder } from "@/lib/state/api";
import type { AutomationLaneRow, PluginParameterList, SongRow, TrackRow } from "@/lib/state/types";
import { DetachedAutomationRecovery } from "@/screens/editor/timeline/automation/components/DetachedAutomationRecovery";

vi.mock("@/components/ui", () => ({
  Button: ({ children, onPress, isDisabled, isIconOnly, ...props }: {
    children?: ReactNode;
    onPress?: () => void;
    isDisabled?: boolean;
    isIconOnly?: boolean;
    [key: string]: unknown;
  }) => createElement("button", {
    ...Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith("aria-") || key === "title")),
    disabled: isDisabled,
    onClick: onPress,
    "data-icon-only": isIconOnly,
  }, children),
  Select: ({ options, value, onChange, ...props }: {
    options: Array<{ id: string; label: ReactNode }>;
    value?: string;
    onChange?: (value: string) => void;
    [key: string]: unknown;
  }) => createElement("select", {
    ...Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith("aria-") || key === "title")),
    value,
    onChange: (event: ChangeEvent<HTMLSelectElement>) => onChange?.(event.currentTarget.value),
  }, options.map((option) => createElement("option", { key: option.id, value: option.id }, option.label)),
  ),
}));

vi.mock("@/lib/state/api", () => ({
  builder: {
    automationLaneUpdate: vi.fn().mockResolvedValue({}),
    automationLaneRemove: vi.fn().mockResolvedValue({}),
  },
}));

const orphanLane: AutomationLaneRow = {
  id: "lane:detached",
  target: {
    domain: "plugin",
    entityId: "slot:removed",
    parameterId: "id:old-filter",
    valueType: "floatNormalized",
    defaultValue: 0.5,
    minValue: 0,
    maxValue: 1,
  },
  scope: "track",
  writeMode: "read",
  enabled: true,
  points: [{ timeBeats: 0, value: 0.7, curve: 0 }],
};

const track = {
  id: "track:keys",
  name: "Keys",
  kind: "instrument",
  plugins: [{ id: "slot:loaded", name: "Synth" }],
} as unknown as TrackRow;

const parameters: Record<string, PluginParameterList> = {
  "slot:loaded": {
    slotId: "slot:loaded",
    loadState: "loaded",
    loadError: "",
    truncated: false,
    parameters: [{
      index: 3,
      parameterId: "id:cutoff",
      name: "Cutoff",
      label: "Hz",
      defaultValue: 0.4,
      currentValue: 0.6,
      steps: 0,
      automatable: true,
    }],
  },
};

describe("DetachedAutomationRecovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    lanes: AutomationLaneRow[] = [orphanLane],
    parameterMetadata = parameters,
    onRevealAutomation = vi.fn(),
  ) {
    act(() => root.render(createElement(DetachedAutomationRecovery, {
      songIndex: 0,
      song: { automationLanes: lanes, regions: [], midiRegions: [] } as unknown as SongRow,
      tracks: [track],
      parameters: parameterMetadata,
      readOnly: false,
      onRevealAutomation,
    })));
    return onRevealAutomation;
  }

  it("keeps detached curves discoverable and rebinds to a real parameter target", async () => {
    render();
    expect(container.textContent).toContain("1 plug-in automation lane is detached");

    const reviewButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Review and recover"));
    expect(reviewButton).toBeDefined();
    act(() => reviewButton?.click());
    expect(container.textContent).toContain("Song automation · id:old-filter");
    expect(container.textContent).toContain("1 points preserved");

    const select = container.querySelector<HTMLSelectElement>("select[aria-label='Rebind id:old-filter']");
    expect(select).not.toBeNull();
    act(() => {
      select!.value = 'plugin:["track:keys","slot:loaded"]:id:cutoff';
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const rebindButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Rebind"));
    await act(async () => {
      rebindButton?.click();
      await Promise.resolve();
    });

    expect(builder.automationLaneUpdate).toHaveBeenCalledWith({
      songIndex: 0,
      laneId: "lane:detached",
      target: {
        domain: "plugin",
        entityId: "slot:loaded",
        parameterId: "id:cutoff",
        valueType: "floatNormalized",
        defaultValue: 0.4,
        minValue: 0,
        maxValue: 1,
      },
    });
  });

  it("can remove a detached lane through the shared history command", async () => {
    render();
    const reviewButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Review and recover"));
    act(() => reviewButton?.click());
    const removeButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Remove detached lane id:old-filter']",
    );
    await act(async () => {
      removeButton?.click();
      await Promise.resolve();
    });
    expect(builder.automationLaneRemove).toHaveBeenCalledWith(0, "lane:detached");
  });

  it("reveals and recovers a lane whose loaded plug-in no longer exposes its parameter", () => {
    const unboundLane: AutomationLaneRow = {
      ...orphanLane,
      id: "lane:unbound",
      target: { ...orphanLane.target, entityId: "slot:loaded", parameterId: "id:removed" },
    };
    const reveal = vi.fn();
    render([unboundLane], parameters, reveal);
    expect(container.textContent).toContain("1 plug-in automation lane is detached");

    const reviewButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Review and recover"));
    act(() => reviewButton?.click());

    expect(reveal).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Parameter is no longer exposed as automatable");
    expect(container.textContent).toContain("Song automation · id:removed");
  });
});
