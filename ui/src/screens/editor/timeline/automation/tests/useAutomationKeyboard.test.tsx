/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hotkeyManager, HotkeyScope } from "@/lib/interaction/HotkeyManager";
import { useAutomationKeyboard } from "@/screens/editor/timeline/automation/hooks/useAutomationKeyboard";

describe("useAutomationKeyboard", () => {
  let root: Root;
  let container: HTMLDivElement;
  let unmountManager: () => void;

  const deleteSelectedPoints = vi.fn();
  const selectAllPoints = vi.fn();
  const clearSelection = vi.fn();
  const copySelectedPoints = vi.fn();
  const cutSelectedPoints = vi.fn();
  const pastePoints = vi.fn();
  const duplicateSelectedPoints = vi.fn();
  const onEditValue = vi.fn();

  function KeyboardHarness({
    id = "lane-1",
    readOnly = false,
  }: {
    id?: string;
    readOnly?: boolean;
  }) {
    const surfaceRef = useRef<HTMLDivElement>(null);
    useAutomationKeyboard(id, surfaceRef, readOnly, {
      deleteSelectedPoints,
      selectAllPoints,
      clearSelection,
      copySelectedPoints,
      cutSelectedPoints,
      pastePoints,
      duplicateSelectedPoints,
      onEditValue,
    });
    return createElement("div", {
      ref: surfaceRef,
      tabIndex: -1,
      id: "automation-surface",
      "data-testid": "surface",
    });
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    unmountManager = hotkeyManager.mount(window);
    hotkeyManager.setScopeActive(HotkeyScope.Timeline, true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    hotkeyManager.setScopeActive(HotkeyScope.Timeline, false);
    unmountManager();
    act(() => root.unmount());
    container.remove();
  });

  it("deletes selected points only when the surface is focused", () => {
    act(() => {
      root.render(createElement(KeyboardHarness, { id: "lane-test" }));
    });

    const surface = container.querySelector<HTMLDivElement>("#automation-surface")!;
    expect(surface).not.toBeNull();

    // 1. Surface is NOT focused -> Delete must NOT call deleteSelectedPoints
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }),
    );
    expect(deleteSelectedPoints).not.toHaveBeenCalled();

    // 2. Surface IS focused -> Delete must call deleteSelectedPoints
    surface.focus();
    expect(document.activeElement).toBe(surface);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }),
    );
    expect(deleteSelectedPoints).toHaveBeenCalledTimes(1);

    // 3. Backspace also deletes
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", bubbles: true }),
    );
    expect(deleteSelectedPoints).toHaveBeenCalledTimes(2);
  });

  it("selects all points on Mod+A and clears selection on Escape when focused", () => {
    act(() => {
      root.render(createElement(KeyboardHarness, { id: "lane-test" }));
    });

    const surface = container.querySelector<HTMLDivElement>("#automation-surface")!;
    surface.focus();

    const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
      }),
    );
    expect(selectAllPoints).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
    expect(clearSelection).toHaveBeenCalledTimes(1);
  });

  it("does not register shortcuts when readOnly is true", () => {
    act(() => {
      root.render(createElement(KeyboardHarness, { id: "lane-test", readOnly: true }));
    });

    const surface = container.querySelector<HTMLDivElement>("#automation-surface")!;
    surface.focus();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }),
    );
    expect(deleteSelectedPoints).not.toHaveBeenCalled();
  });

  it("triggers onEditValue on Enter and NumpadEnter when surface is focused", () => {
    act(() => {
      root.render(createElement(KeyboardHarness, { id: "lane-test" }));
    });

    const surface = container.querySelector<HTMLDivElement>("#automation-surface")!;
    expect(surface).not.toBeNull();

    // Not focused -> should not trigger
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
    );
    expect(onEditValue).not.toHaveBeenCalled();

    // Focused -> Enter triggers onEditValue
    surface.focus();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
    );
    expect(onEditValue).toHaveBeenCalledTimes(1);

    // NumpadEnter also triggers onEditValue
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "NumpadEnter", bubbles: true }),
    );
    expect(onEditValue).toHaveBeenCalledTimes(2);
  });

  it("triggers copy, cut, paste, and duplicate on Mod shortcuts when surface is focused", () => {
    act(() => {
      root.render(createElement(KeyboardHarness, { id: "lane-test" }));
    });

    const surface = container.querySelector<HTMLDivElement>("#automation-surface")!;
    surface.focus();

    const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
    const modKey = isMac ? { metaKey: true } : { ctrlKey: true };

    // Mod+C -> copySelectedPoints
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", code: "KeyC", ...modKey, bubbles: true }),
    );
    expect(copySelectedPoints).toHaveBeenCalledTimes(1);

    // Mod+X -> cutSelectedPoints
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", code: "KeyX", ...modKey, bubbles: true }),
    );
    expect(cutSelectedPoints).toHaveBeenCalledTimes(1);

    // Mod+V -> pastePoints
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "v", code: "KeyV", ...modKey, bubbles: true }),
    );
    expect(pastePoints).toHaveBeenCalledTimes(1);

    // Mod+D -> duplicateSelectedPoints
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "d", code: "KeyD", ...modKey, bubbles: true }),
    );
    expect(duplicateSelectedPoints).toHaveBeenCalledTimes(1);
  });
});
