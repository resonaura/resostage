/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendOrigin, setRemoteBackend } from "@/lib/state/backend";
import {
  clearApiCaches,
  currentProjectCommandIdentity,
  observeProjectCommandIdentity,
  project,
  postReliable,
} from "@/lib/state/api";

beforeEach(() => {
  setRemoteBackend(null);
  window.history.replaceState({}, "", "/?embedded=1");
  delete (window as unknown as { resostageElectron?: unknown }).resostageElectron;
  clearApiCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project-scoped command identity", () => {
  it("retains the last complete identity across partial view snapshots", () => {
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });
    const observed = currentProjectCommandIdentity();
    observeProjectCommandIdentity({ stateRevision: 99, tracks: [] });
    expect(currentProjectCommandIdentity()).toEqual(observed);

    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 13 });
    expect(currentProjectCommandIdentity()).toEqual({
      origin: backendOrigin(), stateSessionId: "Core A", projectEpoch: 13,
    });
  });

  it("sends an exact, project-fenced editor edit and confirms its matching result", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/builder/midi-region/update"))
        return new Response(JSON.stringify({
          accepted: true, requestId: 41, stateSessionId: "Core A", projectEpoch: 12,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({
        stateSessionId: "Core A",
        projectEpoch: 12,
        stateRevision: 88,
        editorCommandResults: [{
          requestId: 41, applied: true, projectEpoch: 12, projectRevision: 88, error: "",
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    await postReliable("/api/v1/builder/midi-region/update", { songIndex: 0, regionId: "r" });

    expect(fetch).toHaveBeenCalledTimes(2);
    const sentRequest = fetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(sentRequest[1]?.headers).toMatchObject({
      "X-ResoStage-Session": "Core A",
      "X-ResoStage-Project-Epoch": "12",
    });
  });

  it("fences destructive project lifecycle commands to the observed project", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    await project.new();

    const sentRequest = fetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(sentRequest[0])).toMatch(/\/api\/v1\/project\/new$/);
    expect(sentRequest[1]?.headers).toMatchObject({
      "X-ResoStage-Session": "Core A",
      "X-ResoStage-Project-Epoch": "12",
    });
  });
});
