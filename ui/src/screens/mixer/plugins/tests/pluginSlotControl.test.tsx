/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSlotControl } from "@/screens/mixer/plugins/PluginSlotControl";

describe("plug-in slot runtime readiness", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onOpen = vi.fn();
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onOpen.mockClear();
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const render = (loadState: "loading" | "loaded" | "failed", bypassed = false) => {
    act(() => root.render(createElement(PluginSlotControl, {
      name: "Synth", bypassed, loadState,
      onOpen, onToggle: vi.fn(), onSwap: vi.fn(), onDelete: vi.fn(),
    })));
  };
  it("keeps pending slots dim and disables editor while allowing swap/delete", () => {
    render("loading");
    const slot = container.firstElementChild!;
    expect(slot.getAttribute("aria-busy")).toBe("true");
    expect(slot.className).toContain("text-foreground/40");
    expect((container.querySelector('[aria-label="Open Synth editor"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[aria-label="Swap Synth"]') as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('[aria-label="Delete Synth"]') as HTMLButtonElement).disabled).toBe(false);
  });
  it("opens only initialized processors, including deliberately bypassed ones", () => {
    render("loaded", true);
    const open = container.querySelector('[aria-label="Open Synth editor"]') as HTMLButtonElement;
    act(() => open.click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(container.firstElementChild!.className).toContain("text-foreground/40");
    render("loaded");
    expect(container.firstElementChild!.className).toContain("border-foreground/55");
  });
  it("failed slots remain unavailable rather than looking active", () => {
    render("failed");
    expect(container.textContent).toContain("Unavailable");
    expect(container.firstElementChild!.getAttribute("aria-busy")).toBe("false");
    const open = container.querySelector('[aria-label="Open Synth editor"]') as HTMLButtonElement;
    act(() => open.click());
    expect(onOpen).not.toHaveBeenCalled();
  });
});
