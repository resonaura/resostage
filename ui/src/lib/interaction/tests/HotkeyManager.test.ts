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
});
