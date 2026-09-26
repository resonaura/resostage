import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
  },
  Menu: {
    setApplicationMenu: vi.fn(),
  },
  TouchBar: {},
}));

import { MacPlatformAdapter } from "./MacPlatformAdapter.js";
import { WindowsPlatformAdapter } from "./WindowsPlatformAdapter.js";
import { LinuxPlatformAdapter } from "./LinuxPlatformAdapter.js";
import type { PlatformContext } from "./PlatformAdapter.js";

const mockContext: PlatformContext = {
  getMainWindow: () => null,
  postAction: async () => true,
  appName: "ResoStage",
};

describe("Window bounds and initial state across platforms", () => {
  it("MacPlatformAdapter fills the exact workArea without entering exclusive fullscreen", () => {
    const mac = new MacPlatformAdapter(mockContext);
    // Typical MacBook Pro workArea with notch / menu bar (e.g. y=38) and dock at bottom
    const workArea = { x: 0, y: 38, width: 1728, height: 1079 };
    const bounds = mac.getInitialWindowBounds(workArea);

    expect(bounds).toEqual({
      x: 0,
      y: 38,
      width: 1728,
      height: 1079,
    });

    const mockWin = { maximize: vi.fn() };
    mac.applyInitialWindowState(mockWin as any);
    // On Mac, does not call maximize() to avoid full-screen space behavior
    expect(mockWin.maximize).not.toHaveBeenCalled();
  });

  it("WindowsPlatformAdapter calculates centered restore bounds and maximizes inside workArea", () => {
    const win = new WindowsPlatformAdapter(mockContext);
    // Typical 1080p display with bottom taskbar (48px)
    const workArea = { x: 0, y: 0, width: 1920, height: 1032 };
    const bounds = win.getInitialWindowBounds(workArea);

    // Should return centered restore dimensions <= 1440x900
    expect(bounds.width).toBe(1440);
    expect(bounds.height).toBe(877); // 1032 * 0.85 = 877.2 -> 877
    expect(bounds.x).toBe(Math.round((1920 - 1440) / 2));
    expect(bounds.y).toBe(Math.round((1032 - 877) / 2));

    const mockWin = { maximize: vi.fn() };
    win.applyInitialWindowState(mockWin as any);
    expect(mockWin.maximize).toHaveBeenCalledTimes(1);
  });

  it("LinuxPlatformAdapter calculates restore bounds and maximizes", () => {
    const linux = new LinuxPlatformAdapter(mockContext);
    const workArea = { x: 0, y: 32, width: 1920, height: 1048 };
    const bounds = linux.getInitialWindowBounds(workArea);

    expect(bounds.width).toBe(1440);
    expect(bounds.height).toBe(891);
    expect(bounds.x).toBe(Math.round((1920 - 1440) / 2));
    expect(bounds.y).toBe(32 + Math.round((1048 - 891) / 2));

    const mockWin = { maximize: vi.fn() };
    linux.applyInitialWindowState(mockWin as any);
    expect(mockWin.maximize).toHaveBeenCalledTimes(1);
  });
});
