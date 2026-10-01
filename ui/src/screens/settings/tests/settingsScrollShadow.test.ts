/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsScreen } from "@/screens/settings/SettingsScreen";
import type { WebUiState } from "@/lib/state/types";
import type { PerformanceControls, ThemeControls } from "@/screens/settings/types";

describe("SettingsScreen ScrollShadow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders with ScrollShadow wrapping settings tab panels", () => {
    const dummyState = {
      projectName: "Test Project",
      settings: {
        outputDevices: [],
        inputDevices: [],
        availableSampleRates: [],
        availableBufferSizes: [],
        keybindings: [],
        midiBindings: [],
        audioDrivers: [],
        outputChannelNames: [],
        activeOutputChannels: [],
      },
      songs: [],
      tracks: [],
    } as unknown as WebUiState;
    const dummyPerformance = {
      effectiveTier: "normal",
      degraded: false,
    } as unknown as PerformanceControls;
    const dummyTheme = {
      name: "dark",
      setName: () => {},
    } as unknown as ThemeControls;

    act(() => {
      root.render(
        createElement(SettingsScreen, {
          state: dummyState,
          performance: dummyPerformance,
          theme: dummyTheme,
        }),
      );
    });

    // Check that ScrollShadow container is present in the DOM for settings content
    const scrollShadow = container.querySelector("[data-orientation='vertical']") ||
      container.querySelector(".overflow-y-auto");
    expect(scrollShadow).not.toBeNull();
  });
});
