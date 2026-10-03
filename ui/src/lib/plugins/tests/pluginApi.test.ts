/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  builder,
  clearApiCaches,
  EDITOR_COMMAND_FAILURE_EVENT,
  pluginCatalog,
  pluginChains,
} from "@/lib/state/api";
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
    clearApiCaches();
  });

  it("parameters() preserves actual identities, values and metadata status", async () => {
    const metadata = {
      slotId: "slot 123",
      loadState: "loaded",
      loadError: "",
      truncated: false,
      parameters: [{ index: 7, parameterId: "id:cutoff", name: "Cutoff", label: "Hz",
        defaultValue: 0.5, currentValue: 0.72, steps: 0, automatable: true }],
    };
    const fetchSpy = vi.spyOn(backend, "apiFetch").mockResolvedValue({
      ok: true, json: async () => metadata,
    } as Response);
    expect(await pluginChains.parameters(metadata.slotId)).toEqual(metadata);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/plugins/slot/parameters?slotId=slot%20123",
    );
  });

  it("parameterValues() fetches lightweight latest values by slot ID", async () => {
    const values = { slotId: "slot 123", loadState: "loaded", loadError: "",
      values: [{ index: 7, value: 0.72 }] };
    const fetchSpy = vi.spyOn(backend, "apiFetch").mockResolvedValue({
      ok: true, json: async () => values,
    } as Response);
    expect(await pluginChains.parameterValues(values.slotId)).toEqual(values);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/plugins/slot/parameter-values?slotId=slot%20123",
    );
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
    let requestId = 0;
    const fetchSpy = vi.spyOn(backend, "apiFetch").mockImplementation(async (path) => {
      if (path === "/api/v1/plugins/slot/move") {
        requestId += 1;
        return {
          ok: true,
          status: 202,
          text: async () => "{}",
          json: async () => ({
            accepted: true,
            requestId,
            stateSessionId: "Core",
            projectEpoch: 0,
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({
          stateSessionId: "Core",
          projectEpoch: 0,
          stateRevision: requestId,
          playbackProjectEpoch: 1,
          playbackProjectRevision: requestId,
          editorCommandResults: [{
            requestId,
            applied: true,
            projectEpoch: 0,
            projectRevision: requestId,
            applicationDomain: "audio",
            playbackApplied: true,
            playbackProjectEpoch: 1,
            playbackRevision: requestId,
          }],
        }),
      } as unknown as Response;
    });

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

describe("atomic automation edits", () => {
  beforeEach(() => { vi.restoreAllMocks(); clearApiCaches(); });

  const mockAppliedEdit = (revision: number, requestId: number) => {
    const fetchSpy = vi.spyOn(backend, "apiFetch");
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 202,
      json: async () => ({ accepted: true, requestId, stateSessionId: "Core", projectEpoch: 0 }),
    } as unknown as Response);
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        stateSessionId: "Core", projectEpoch: 0, stateRevision: revision,
        editorCommandResults: [{
          requestId, applied: true, projectEpoch: 0, projectRevision: revision, error: "",
        }],
      }),
    } as unknown as Response);
    return fetchSpy;
  };

  it("replaces an envelope in one reliable request preserving curves", async () => {
    const fetchSpy = mockAppliedEdit(7, 1);
    const patch = { songIndex: 0, laneId: "lane", gestureId: "gesture",
      points: [{ timeBeats: 1, value: 0.2, curve: -0.5 }, { timeBeats: 3, value: 0.9, curve: 0.3 }] };
    await builder.automationPointsReplace(patch);
    expect(fetchSpy).toHaveBeenNthCalledWith(1, "/api/v1/builder/automation-points/replace", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
  });

  it("empty explicit points create an untouched lane without seeded dots", async () => {
    const fetchSpy = mockAppliedEdit(8, 2);
    const patch = { songIndex: 0, domain: "strip" as const, entityId: "audio::track:1",
      parameterId: "pan", points: [] };
    await builder.automationLaneAdd(patch);
    expect(fetchSpy).toHaveBeenNthCalledWith(1, "/api/v1/builder/automation-lane/add", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
  });

  it("rejected and failed requests stay visible to the editor", async () => {
    const fetchSpy = vi.spyOn(backend, "apiFetch").mockResolvedValue({
      ok: false, status: 503, text: async () => "Core command queue is full",
    } as Response);
    await expect(builder.automationPointsReplace({ songIndex: 0, laneId: "lane", points: [] }))
      .rejects.toThrow("Core command queue is full");
    fetchSpy.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(builder.automationLaneAdd({ songIndex: 0, domain: "strip",
      entityId: "track", parameterId: "pan" })).rejects.toThrow("Disconnected");
  });

  it("treats Core queue-full as a definite rejection and publishes the shared failure event", async () => {
    const failure = vi.fn();
    window.addEventListener(EDITOR_COMMAND_FAILURE_EVENT, failure);
    vi.spyOn(backend, "apiFetch").mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Core command queue is full; retry the command",
    } as Response);

    await expect(builder.automationPointRemove(0, "lane", 1))
      .rejects.toMatchObject({ outcome: "rejected" });

    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0][0]).toBeInstanceOf(CustomEvent);
    expect((failure.mock.calls[0][0] as CustomEvent<{ message: string }>).detail.message)
      .toContain("queue is full");
    window.removeEventListener(EDITOR_COMMAND_FAILURE_EVENT, failure);
  });
});
