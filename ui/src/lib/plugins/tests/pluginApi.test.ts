/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pluginCatalog, pluginChains } from "@/lib/state/api";
import * as backend from "@/lib/state/backend";

describe("pluginCatalog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list() calls /api/v1/plugins/list and parses result", async () => {
    const mockData = {
      scan: {
        state: "idle",
        progress: 1,
        format: "",
        formatIndex: 2,
        formatCount: 2,
        formatProgress: 1,
        currentPlugin: "",
        error: "",
      },
      catalog: {
        plugins: [],
        blacklist: [],
      },
    };

    vi.spyOn(backend, "apiFetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(mockData),
      json: async () => mockData,
    } as unknown as Response);

    const result = await pluginCatalog.list();
    expect(backend.apiFetch).toHaveBeenCalledWith("/api/v1/plugins/list");
    expect(result).toEqual(mockData);
  });

  it("scan() posts to /api/v1/plugins/scan with rescanAll option", async () => {
    vi.spyOn(backend, "apiFetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    } as unknown as Response);

    await pluginCatalog.scan(true);
    expect(backend.apiFetch).toHaveBeenCalledWith("/api/v1/plugins/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rescanAll: true }),
    });
  });

  it("cancelScan() posts to /api/v1/plugins/scan/cancel", async () => {
    vi.spyOn(backend, "apiFetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    } as unknown as Response);

    await pluginCatalog.cancelScan();
    expect(backend.apiFetch).toHaveBeenCalledWith(
      "/api/v1/plugins/scan/cancel",
      {
        method: "POST",
      },
    );
  });

  it("setEnabled() posts to /api/v1/plugins/enabled", async () => {
    vi.spyOn(backend, "apiFetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    } as unknown as Response);

    await pluginCatalog.setEnabled("au:aufx:dely:appl", false);
    expect(backend.apiFetch).toHaveBeenCalledWith("/api/v1/plugins/enabled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pluginId: "au:aufx:dely:appl", enabled: false }),
    });
  });
});

describe("pluginChains", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("openEditor() posts stripId and slotId to /api/v1/plugins/slot/editor", async () => {
    const fetchSpy = vi.spyOn(backend, "apiFetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    } as unknown as Response);

    await pluginChains.openEditor("audio::bus:send:1", "slot_123");
    expect(fetchSpy).toHaveBeenCalledWith("/api/v1/plugins/slot/editor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stripId: "audio::bus:send:1",
        slotId: "slot_123",
      }),
    });
  });

  it("move() posts toIndex and optional delta to /api/v1/plugins/slot/move", async () => {
    const fetchSpy = vi.spyOn(backend, "apiFetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    } as unknown as Response);

    await pluginChains.move("audio::track:1", "slot_abc", 2);
    expect(fetchSpy).toHaveBeenCalledWith("/api/v1/plugins/slot/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stripId: "audio::track:1",
        slotId: "slot_abc",
        toIndex: 2,
      }),
    });

    await pluginChains.move("audio::track:1", "slot_abc", 0, -1);
    expect(fetchSpy).toHaveBeenCalledWith("/api/v1/plugins/slot/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stripId: "audio::track:1",
        slotId: "slot_abc",
        toIndex: 0,
        delta: -1,
      }),
    });
  });
});
