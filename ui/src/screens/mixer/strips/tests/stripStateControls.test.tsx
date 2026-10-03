/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StripStateControls } from "@/screens/mixer/strips/StripStateControls";

describe("mixer bus state controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onShowSignalFlow = vi.fn();

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onShowSignalFlow.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (showSignalFlow = false, audioFlowOpen = false) => {
    act(() => root.render(createElement(StripStateControls, {
      isNarrow: true,
      isRecording: false,
      mute: false,
      solo: false,
      soloSafe: false,
      isDimmed: false,
      onMute: vi.fn(),
      onSolo: vi.fn(),
      onShowSignalFlow: showSignalFlow ? onShowSignalFlow : undefined,
      audioFlowOpen,
      audioFlowLabel: "Reverb",
    })));
  };

  it("keeps the icon-only signal-flow action exclusive to bus strips", () => {
    render();
    expect(container.querySelector('[aria-label="Show audio flow for Reverb"]')).toBeNull();

    render(true);
    const button = container.querySelector('[aria-label="Show audio flow for Reverb"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe("");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    act(() => button.click());
    expect(onShowSignalFlow).toHaveBeenCalledOnce();
  });

  it("marks the bus whose focused graph is currently open", () => {
    render(true, true);
    const button = container.querySelector('[aria-label="Show audio flow for Reverb"]') as HTMLButtonElement;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className).toContain("text-accent");
  });
});
