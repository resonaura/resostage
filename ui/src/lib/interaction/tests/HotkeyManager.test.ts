/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { HotkeyManager, HotkeyScope } from "@/lib/interaction/HotkeyManager";

const mounted: Array<() => void> = [];

afterEach(() => {
  mounted.splice(0).forEach((dispose) => dispose());
});

function manager() {
  const instance = new HotkeyManager();
  mounted.push(instance.mount(window));
  return instance;
}

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

describe("HotkeyManager", () => {
  it("routes persisted bindings to registered action handlers", () => {
    const hotkeys = manager();
    const handler = vi.fn();
    hotkeys.setConfiguredBindings([{ action: "bar_prev", key: "," }]);
    hotkeys.registerActionHandler("bar_prev", handler);

    const event = press(",");

    expect(handler).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("only dispatches scoped editor commands while that scope is active", () => {
    const hotkeys = manager();
    const handler = vi.fn();
    hotkeys.registerCommand(
      "timeline.draw",
      "b",
      { scope: HotkeyScope.Timeline, priority: 100 },
      handler,
    );

    press("b");
    expect(handler).not.toHaveBeenCalled();
    hotkeys.setScopeActive(HotkeyScope.Timeline, true);
    press("b");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("reserves unmodified keys for musical typing", () => {
    const hotkeys = manager();
    const handler = vi.fn();
    hotkeys.setConfiguredBindings([{ action: "play", key: "ctrl + space" }]);
    hotkeys.registerActionHandler("play", handler);
    hotkeys.setMusicalTypingActive(true);

    press(" ");
    expect(handler).not.toHaveBeenCalled();
    press(" ", { ctrlKey: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("blocks previous/next song actions forwarded by Electron while typing MIDI", () => {
    const hotkeys = manager();
    const previous = vi.fn();
    const next = vi.fn();
    hotkeys.registerActionHandler("prev", previous);
    hotkeys.registerActionHandler("next", next);
    hotkeys.setMusicalTypingActive(true);

    expect(hotkeys.dispatchAction("prev")).toBe(false);
    expect(hotkeys.dispatchAction("next")).toBe(false);
    expect(previous).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();

    hotkeys.setMusicalTypingActive(false);
    expect(hotkeys.dispatchAction("prev")).toBe(true);
    expect(hotkeys.dispatchAction("next")).toBe(true);
    expect(previous).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("suspends dispatch while the settings UI captures a key", () => {
    const hotkeys = manager();
    const handler = vi.fn();
    hotkeys.setConfiguredBindings([{ action: "play", key: "space" }]);
    hotkeys.registerActionHandler("play", handler);
    const release = hotkeys.beginKeyCapture();

    press(" ");
    expect(handler).not.toHaveBeenCalled();
    release();
    press(" ");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("auto-blurs input elements when Escape or Enter is pressed", () => {
    manager();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    const escEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(escEvent);
    expect(document.activeElement).not.toBe(input);
    expect(escEvent.defaultPrevented).toBe(true);

    input.focus();
    expect(document.activeElement).toBe(input);
    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(enterEvent);
    expect(document.activeElement).not.toBe(input);
    expect(enterEvent.defaultPrevented).toBe(true);

    document.body.removeChild(input);
  });

  it("isolates Tab outside text inputs and executes registered Tab commands", () => {
    const hotkeys = manager();
    const tabHandler = vi.fn();
    hotkeys.registerCommand(
      "test.tab-action",
      "tab",
      { scope: HotkeyScope.Global, priority: 50 },
      tabHandler,
    );

    const event = press("Tab");
    expect(tabHandler).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("allows an explicit inline-edit owner to settle before blur without global shortcuts", () => {
    const hotkeys = manager();
    const handler = vi.fn();
    hotkeys.setConfiguredBindings([{ action: "cancel", key: "escape" }, { action: "accept", key: "return" }]);
    hotkeys.registerActionHandler("cancel", handler);
    hotkeys.registerActionHandler("accept", handler);
    const input = document.createElement("input");
    input.dataset.rsEditingKeys = "owned";
    document.body.appendChild(input);
    const owner = vi.fn();
    input.addEventListener("keydown", owner);
    input.focus();
    try {
      for (const key of ["Escape", "Enter"]) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(input);
      }
      expect(owner).toHaveBeenCalledTimes(2);
      expect(handler).not.toHaveBeenCalled();
    } finally { input.remove(); }
  });

  it("blurs active element and prevents default when Space is pressed outside inputs", () => {
    const hotkeys = manager();
    const playHandler = vi.fn();
    hotkeys.setConfiguredBindings([{ action: "play", key: "space" }]);
    hotkeys.registerActionHandler("play", playHandler);

    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    const event = press(" ");
    expect(document.activeElement).not.toBe(button);
    expect(event.defaultPrevented).toBe(true);
    expect(playHandler).toHaveBeenCalledOnce();

    document.body.removeChild(button);
  });
});
