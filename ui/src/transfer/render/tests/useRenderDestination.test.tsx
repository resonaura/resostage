/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRemoteBackend } from "@/lib/state/backend";
import { useRenderDestination } from "@/transfer/render/hooks/useRenderDestination";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("audio render destination ownership", () => {
  let container: HTMLDivElement;
  let root: Root;
  let destination: ReturnType<typeof useRenderDestination>;
  let previousBridge: Window["resostageElectron"];
  const picker = vi.fn<(defaultPath?: string) => Promise<string | null>>();
  const remoteStatus = vi.fn<() => Promise<{ isRemoteMode: boolean }>>();

  function Harness({ open, requestId, rememberedDirectory }: {
    open: boolean;
    requestId: number;
    rememberedDirectory: string;
  }) {
    destination = useRenderDestination(open, requestId, rememberedDirectory);
    return null;
  }

  async function render(open = true, requestId = 1, rememberedDirectory = "/Audio Exports") {
    await act(async () => root.render(createElement(Harness, {
      open, requestId, rememberedDirectory,
    })));
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    previousBridge = window.resostageElectron;
    setRemoteBackend(null);
    picker.mockReset().mockResolvedValue("/Chosen folder");
    remoteStatus.mockReset().mockResolvedValue({ isRemoteMode: false });
    window.resostageElectron = {
      isElectron: true,
      chooseAudioRenderDirectory: picker,
      getRemoteStatus: remoteStatus,
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.resostageElectron = previousBridge;
    setRemoteBackend(null);
    vi.restoreAllMocks();
  });

  it("initializes from Core's saved path without overwriting edits on telemetry refresh", async () => {
    await render();
    expect(destination.directory).toBe("/Audio Exports");
    act(() => destination.setDirectory("/Edited folder"));
    await render(true, 1, "/New telemetry path");
    expect(destination.directory).toBe("/Edited folder");
    await render(true, 2, "/New telemetry path");
    expect(destination.directory).toBe("/New telemetry path");
  });

  it("passes the current path to the local picker and retains the selected Unicode folder", async () => {
    picker.mockResolvedValue("/Users/operator/Київ 音楽 exports");
    await render();
    expect(destination.canBrowse).toBe(true);
    await act(async () => destination.chooseDirectory());
    expect(picker).toHaveBeenCalledWith("/Audio Exports");
    expect(destination.directory).toBe("/Users/operator/Київ 音楽 exports");
    expect(destination.choosing).toBe(false);
    expect(destination.error).toBeNull();
  });

  it("keeps the current destination when the native dialog is cancelled", async () => {
    picker.mockResolvedValue(null);
    await render();
    await act(async () => destination.chooseDirectory());
    expect(destination.directory).toBe("/Audio Exports");
    expect(destination.choosing).toBe(false);
    expect(destination.error).toBeNull();
  });

  it("offers only manual Core paths in a browser", async () => {
    delete window.resostageElectron;
    await render();
    expect(destination.canBrowse).toBe(false);
    await act(async () => destination.chooseDirectory());
    expect(picker).not.toHaveBeenCalled();
    act(() => destination.setDirectory("/Volumes/playback/Exports"));
    expect(destination.directory).toBe("/Volumes/playback/Exports");
  });

  it("never opens the controller picker when Electron is attached remotely", async () => {
    remoteStatus.mockResolvedValue({ isRemoteMode: true });
    await render();
    expect(destination.canBrowse).toBe(false);
    await act(async () => destination.chooseDirectory());
    expect(picker).not.toHaveBeenCalled();
  });

  it("respects a remote backend even before Electron's remote status catches up", async () => {
    setRemoteBackend("192.0.2.10:2899");
    await render();
    expect(destination.canBrowse).toBe(false);
    await act(async () => destination.chooseDirectory());
    expect(picker).not.toHaveBeenCalled();
  });

  it("keeps ownership unknown and cannot browse when the shell status request fails", async () => {
    remoteStatus.mockRejectedValue(new Error("Core status unavailable"));
    await render();
    expect(destination.canBrowse).toBe(false);
    await act(async () => destination.chooseDirectory());
    expect(picker).not.toHaveBeenCalled();
  });

  it("shows picker failure without losing the path, and clears it on manual edit", async () => {
    picker.mockRejectedValue(new Error("Folder access denied"));
    await render();
    await act(async () => destination.chooseDirectory());
    expect(destination.directory).toBe("/Audio Exports");
    expect(destination.error).toBe("Folder access denied");
    expect(destination.choosing).toBe(false);
    act(() => destination.setDirectory("/Writable folder"));
    expect(destination.error).toBeNull();
  });

  it.each(["closed", "replaced"])("ignores a late folder result after the request is %s", async (transition) => {
    const selection = deferred<string | null>();
    picker.mockReturnValue(selection.promise);
    await render();
    let choosing!: Promise<void>;
    act(() => { choosing = destination.chooseDirectory(); });
    expect(destination.choosing).toBe(true);
    if (transition === "closed") {
      await render(false);
    } else {
      await render(true, 2, "/Next request destination");
    }
    const expectedPath = destination.directory;
    await act(async () => {
      selection.resolve("/Late previous request path");
      await choosing;
    });
    expect(destination.directory).toBe(expectedPath);
    expect(destination.choosing).toBe(false);
    expect(destination.error).toBeNull();
  });

  it("invalidates a prior Core's path and any in-flight dialog when the backend changes", async () => {
    const selection = deferred<string | null>();
    picker.mockReturnValue(selection.promise);
    await render();
    let choosing!: Promise<void>;
    act(() => { choosing = destination.chooseDirectory(); });
    act(() => setRemoteBackend("192.0.2.11:2899"));
    expect(destination.directory).toBe("");
    expect(destination.canBrowse).toBe(false);
    expect(destination.choosing).toBe(false);
    expect(destination.error).toContain("active Core changed");
    await act(async () => {
      selection.resolve("/Previous Core folder");
      await choosing;
    });
    expect(destination.directory).toBe("");
    expect(destination.error).toContain("active Core changed");
  });

  it("ignores a stale local ownership response after switching Core", async () => {
    const status = deferred<{ isRemoteMode: boolean }>();
    remoteStatus.mockReturnValue(status.promise);
    await render();
    act(() => setRemoteBackend("192.0.2.12:2899"));
    await act(async () => { status.resolve({ isRemoteMode: false }); });
    expect(destination.canBrowse).toBe(false);
    expect(destination.directory).toBe("");
  });
});
