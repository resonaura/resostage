/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePianoRollPlayheadFollow } from "@/screens/editor/pianoroll/hooks/usePianoRollPlayheadFollow";
import { PianoRollFollowControl } from "@/screens/editor/pianoroll/components/PianoRollFollowControl";
import type { PianoRollViewport } from "@/screens/editor/pianoroll/logic/types";

describe("PianoRoll Follow & Playhead", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("updates playheadRef directly on animation frame without React re-render desync", () => {
    let currentVp: PianoRollViewport = {
      pixelsPerBeat: 100,
      pixelsPerPitch: 20,
      scrollBeats: 0,
      scrollPitch: 60,
      keyWidth: 50,
      velocityLaneHeight: 80,
    };

    const containerEl = document.createElement("div");
    Object.defineProperty(containerEl, "clientWidth", { value: 1000, configurable: true });
    const playheadEl = document.createElement("div");

    function TestHarness({ isPlaying, beats }: { isPlaying: boolean; beats: number }) {
      const containerRef = { current: containerEl };
      const canvasRef = { current: null };
      const playheadRef = { current: playheadEl };
      const draggingRef = { current: null };

      usePianoRollPlayheadFollow({
        canvasRef,
        containerRef,
        playheadRef,
        isPlaying,
        followMode: "off",
        catchOnPlay: true,
        catchOnSeek: true,
        playheadBeats: beats,
        getLivePlayheadBeats: () => beats,
        viewport: currentVp,
        onViewportChange: (fn) => {
          if (typeof fn === "function") currentVp = fn(currentVp);
          else currentVp = fn;
        },
        draggingRef,
      });

      return null;
    }

    act(() => {
      root.render(createElement(TestHarness, { isPlaying: false, beats: 2 }));
    });

    // 50 (keyWidth) + (2 beat - 0 scrollBeats) * 100 ppb = 250px
    expect(playheadEl.style.left).toBe("250px");
    expect(playheadEl.style.display).toBe("block");
  });

  it("triggers catch on playback start when playhead is offscreen", () => {
    let currentVp: PianoRollViewport = {
      pixelsPerBeat: 100,
      pixelsPerPitch: 20,
      scrollBeats: 10, // viewport is [10, 19.5]
      scrollPitch: 60,
      keyWidth: 50,
      velocityLaneHeight: 80,
    };

    const containerEl = document.createElement("div");
    Object.defineProperty(containerEl, "clientWidth", { value: 1000, configurable: true });
    const playheadEl = document.createElement("div");

    function TestHarness({ isPlaying }: { isPlaying: boolean }) {
      const containerRef = { current: containerEl };
      const canvasRef = { current: null };
      const playheadRef = { current: playheadEl };
      const draggingRef = { current: null };

      usePianoRollPlayheadFollow({
        canvasRef,
        containerRef,
        playheadRef,
        isPlaying,
        followMode: "snap",
        catchOnPlay: true,
        catchOnSeek: true,
        playheadBeats: 2, // playhead at 2 is offscreen when scrollBeats is 10
        getLivePlayheadBeats: () => 2,
        viewport: currentVp,
        onViewportChange: (fn) => {
          if (typeof fn === "function") currentVp = fn(currentVp);
          else currentVp = fn;
        },
        draggingRef,
      });

      return null;
    }

    act(() => {
      root.render(createElement(TestHarness, { isPlaying: false }));
    });
    expect(currentVp.scrollBeats).toBe(10);

    // Start playback
    act(() => {
      root.render(createElement(TestHarness, { isPlaying: true }));
    });

    // Should reveal playhead to ~0 beats
    expect(currentVp.scrollBeats).toBeLessThan(5);
  });

  it("triggers catch on seek when playhead jumps offscreen", () => {
    let currentVp: PianoRollViewport = {
      pixelsPerBeat: 100,
      pixelsPerPitch: 20,
      scrollBeats: 0,
      scrollPitch: 60,
      keyWidth: 50,
      velocityLaneHeight: 80,
    };

    const containerEl = document.createElement("div");
    Object.defineProperty(containerEl, "clientWidth", { value: 1000, configurable: true });
    const playheadEl = document.createElement("div");

    function TestHarness({ beats }: { beats: number }) {
      const containerRef = { current: containerEl };
      const canvasRef = { current: null };
      const playheadRef = { current: playheadEl };
      const draggingRef = { current: null };

      usePianoRollPlayheadFollow({
        canvasRef,
        containerRef,
        playheadRef,
        isPlaying: false,
        followMode: "snap",
        catchOnPlay: true,
        catchOnSeek: true,
        playheadBeats: beats,
        getLivePlayheadBeats: () => beats,
        viewport: currentVp,
        onViewportChange: (fn) => {
          if (typeof fn === "function") currentVp = fn(currentVp);
          else currentVp = fn;
        },
        draggingRef,
      });

      return null;
    }

    act(() => {
      root.render(createElement(TestHarness, { beats: 2 }));
    });
    expect(currentVp.scrollBeats).toBe(0);

    // Seek far offscreen to beat 50
    act(() => {
      root.render(createElement(TestHarness, { beats: 50 }));
    });

    // Should reveal playhead
    expect(currentVp.scrollBeats).toBeGreaterThan(40);
  });

  it("toggles options correctly in PianoRollFollowControl", () => {
    let playChecked = true;
    let seekChecked = true;

    act(() => {
      root.render(
        createElement(PianoRollFollowControl, {
          followMode: "snap",
          onCycleFollowMode: vi.fn(),
          catchOnPlay: playChecked,
          onCatchOnPlayChange: (val) => { playChecked = val; },
          catchOnSeek: seekChecked,
          onCatchOnSeekChange: (val) => { seekChecked = val; },
        }),
      );
    });

    const button = container.querySelector("button")!;
    expect(button).not.toBeNull();

    // Context menu opening
    act(() => {
      button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
    });

    // Check menu items
    const menuItems = document.querySelectorAll("[role='menuitemcheckbox']");
    expect(menuItems.length).toBe(2);
    expect(menuItems[0].textContent).toContain("Catch when Starting Playback");
    expect(menuItems[1].textContent).toContain("Catch when Moving Playhead");

    // Click Catch when Starting Playback
    act(() => {
      (menuItems[0] as HTMLElement).click();
    });
    expect(playChecked).toBe(false);

    // Click Catch when Moving Playhead
    act(() => {
      (menuItems[1] as HTMLElement).click();
    });
    expect(seekChecked).toBe(false);
  });
});
