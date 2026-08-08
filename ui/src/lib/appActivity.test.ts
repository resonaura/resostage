// @vitest-environment jsdom
//
// The precedence rule here is subtle and was got wrong once already: the
// Electron shell launches Chromium with renderer backgrounding disabled, so a
// hidden window's page can keep reporting `visibilityState === "visible"`.
// Any logic that lets the page's own opinion veto the shell's therefore never
// sleeps at all -- which looks exactly like the feature working, until you
// measure. These tests pin the rule from both sides.

import { beforeEach, describe, expect, it } from "vitest";
import { isRenderActive, setTransportPlaying } from "./appActivity";

function shell(event: "resoshell-idle" | "resoshell-active") {
  window.dispatchEvent(new CustomEvent(event));
}

describe("appActivity", () => {
  beforeEach(() => {
    // Back to "on screen, stopped" before each case.
    shell("resoshell-active");
    setTransportPlaying(false);
  });

  it("is active by default", () => {
    expect(isRenderActive()).toBe(true);
  });

  it("suspends when the shell says the window is away", () => {
    shell("resoshell-idle");
    expect(isRenderActive()).toBe(false);
  });

  it("lets the shell suspend the page even while it reports itself visible", () => {
    // jsdom's visibilityState is "visible" throughout -- the exact condition
    // the shell's disabled-backgrounding switches produce in the real app.
    expect(document.visibilityState).toBe("visible");
    shell("resoshell-idle");
    expect(isRenderActive()).toBe(false);
  });

  it("wakes instantly on the shell's active signal", () => {
    shell("resoshell-idle");
    shell("resoshell-active");
    expect(isRenderActive()).toBe(true);
  });

  it("wakes on a resume broadcast (sleep / black-screen recovery)", () => {
    shell("resoshell-idle");
    window.dispatchEvent(new CustomEvent("resoshell-resume"));
    expect(isRenderActive()).toBe(true);
  });

  it("never suspends while the transport is running", () => {
    setTransportPlaying(true);
    shell("resoshell-idle");
    expect(isRenderActive()).toBe(true);
  });

  it("wakes the moment playback starts on an already-suspended window", () => {
    shell("resoshell-idle");
    expect(isRenderActive()).toBe(false);
    setTransportPlaying(true);
    expect(isRenderActive()).toBe(true);
  });

  it("stays suspended after playback stops if the window is still away", () => {
    shell("resoshell-idle");
    setTransportPlaying(true);
    setTransportPlaying(false);
    expect(isRenderActive()).toBe(false);
  });

  it("wakes on user input, whatever every other signal claims", () => {
    shell("resoshell-idle");
    expect(isRenderActive()).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(isRenderActive()).toBe(true);
  });
});
