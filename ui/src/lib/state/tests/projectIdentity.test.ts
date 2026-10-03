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
  builder,
  pluginChains,
  EDITOR_COMMAND_FAILURE_EVENT,
  lighting,
  registerRefetchHandler,
  unregisterRefetchHandler,
} from "@/lib/state/api";

beforeEach(() => {
  setRemoteBackend(null);
  window.history.replaceState({}, "", "/?embedded=1");
  delete (window as unknown as { resostageElectron?: unknown }).resostageElectron;
  clearApiCaches();
});

afterEach(() => {
  unregisterRefetchHandler();
  vi.useRealTimers();
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
        playbackProjectEpoch: 6,
        playbackProjectRevision: 88,
        editorCommandResults: [{
          requestId: 41, applied: true, projectEpoch: 12, projectRevision: 88, error: "",
          playbackApplied: true, playbackProjectEpoch: 6, playbackRevision: 88,
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

  it("confirms lighting project edits against LightEngine instead of the audio graph", async () => {
    const requestId = 74;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/lighting/track/add"))
        return new Response(JSON.stringify({
          accepted: true, requestId, stateSessionId: "Core A", projectEpoch: 12,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({
        stateSessionId: "Core A",
        projectEpoch: 12,
        stateRevision: 89,
        // Lighting does not alter the audio graph. It must not be rejected
        // just because that graph's revision is older than project history.
        playbackProjectEpoch: 6,
        playbackProjectRevision: 88,
        editorCommandResults: [{
          requestId,
          applied: true,
          projectEpoch: 12,
          projectRevision: 89,
          error: "",
          applicationDomain: "lighting",
          lightingApplied: true,
          playbackApplied: false,
          playbackProjectEpoch: 6,
          playbackRevision: 88,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    await lighting.trackAdd();

    expect(fetch).toHaveBeenCalledTimes(2);
    const acceptedRequest = fetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(acceptedRequest[1]?.headers).toMatchObject({
      "X-ResoStage-Session": "Core A",
      "X-ResoStage-Project-Epoch": "12",
    });
  });

  it("confirms structural plug-in chain edits against their exact audio graph revision", async () => {
    const requestId = 76;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/plugins/slot/remove"))
        return new Response(JSON.stringify({
          accepted: true, requestId, stateSessionId: "Core A", projectEpoch: 12,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({
        stateSessionId: "Core A",
        projectEpoch: 12,
        stateRevision: 90,
        playbackProjectEpoch: 6,
        playbackProjectRevision: 90,
        editorCommandResults: [{
          requestId,
          applied: true,
          projectEpoch: 12,
          projectRevision: 90,
          error: "",
          applicationDomain: "audio",
          playbackApplied: true,
          playbackProjectEpoch: 6,
          playbackRevision: 90,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    await pluginChains.remove("audio::track:1", "slot::one");

    expect(fetch).toHaveBeenCalledTimes(2);
    const acceptedRequest = fetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(acceptedRequest[1]?.headers).toMatchObject({
      "X-ResoStage-Session": "Core A",
      "X-ResoStage-Project-Epoch": "12",
    });
  });

  it("fences transient automation ownership to the project observed at gesture start", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    await builder.automationManualOverride({
      songIndex: 2,
      laneId: "lane-1",
      active: true,
    });

    const [url, request] = fetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(url)).toMatch(/\/api\/v1\/builder\/automation\/manual-override$/);
    expect(request.headers).toMatchObject({
      "X-ResoStage-Session": "Core A",
      "X-ResoStage-Project-Epoch": "12",
    });
    expect(JSON.parse(String(request.body))).toEqual({
      songIndex: 2,
      laneId: "lane-1",
      active: true,
    });
  });

  it("does not treat a committed project edit as audible when Core retained an older graph", async () => {
    const requestId = 42;
    const applySnapshot = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/builder/midi-region/update"))
        return new Response(JSON.stringify({
          accepted: true, requestId, stateSessionId: "Core A", projectEpoch: 12,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({
        stateSessionId: "Core A",
        projectEpoch: 12,
        stateRevision: 89,
        playbackProjectEpoch: 6,
        playbackProjectRevision: 88,
        editorCommandResults: [{
          requestId, applied: true, projectEpoch: 12, projectRevision: 89,
          error: "Project edit was stored, but its audio snapshot could not be published",
          playbackApplied: false, playbackProjectEpoch: 6, playbackRevision: 88,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    registerRefetchHandler(applySnapshot);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    await expect(postReliable("/api/v1/builder/midi-region/update", {
      songIndex: 0, regionId: "r", name: "Committed edit",
    })).rejects.toThrow(/stored, but its audio snapshot could not be published/);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(applySnapshot).toHaveBeenCalledWith(expect.objectContaining({ stateRevision: 89 }));
  });

  it("rejects a playback ACK from a different AudioEngine project epoch", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/v1/builder/midi-region/update"))
        return new Response(JSON.stringify({
          accepted: true, requestId: 43, stateSessionId: "Core A", projectEpoch: 12,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({
        stateSessionId: "Core A",
        projectEpoch: 12,
        stateRevision: 90,
        playbackProjectEpoch: 7,
        playbackProjectRevision: 900,
        editorCommandResults: [{
          requestId: 43, applied: true, projectEpoch: 12, projectRevision: 90, error: "",
          playbackApplied: true, playbackProjectEpoch: 6, playbackRevision: 900,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    await expect(postReliable("/api/v1/builder/midi-region/update", {
      songIndex: 0, regionId: "r", name: "Old graph has a larger revision",
    })).rejects.toThrow(/inconsistent playback-snapshot identity/);
  });

  it("keeps an evicted exact result unresolved and never resends the accepted edit", async () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/v1/builder/midi-region/update"))
        return new Response(JSON.stringify({
          accepted: true, requestId: 43, stateSessionId: "Core A", projectEpoch: 12,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({
        stateSessionId: "Core A", projectEpoch: 12, stateRevision: 91,
        editorCommandResults: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    registerRefetchHandler(refetch);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    const result = postReliable("/api/v1/builder/midi-region/update", {
      songIndex: 0, regionId: "r", name: "Do not resend",
    });
    const rejected = expect(result).rejects.toThrow(/outcome is unknown.*not resent.*Do not retry blindly/);
    await vi.runAllTimersAsync();
    await rejected;

    expect(fetch.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/v1/builder/midi-region/update"),
    )).toHaveLength(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces rejected fire-and-forget edits through the shell error event", async () => {
    const failure = vi.fn();
    const fetch = vi.fn(async () => new Response("Core command queue is full", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    window.addEventListener(EDITOR_COMMAND_FAILURE_EVENT, failure);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    await expect(builder.regionRemove(0, "region-id")).rejects.toThrow("Core command queue is full");

    expect(failure).toHaveBeenCalledTimes(1);
    const dispatched = failure.mock.calls[0]?.[0] as CustomEvent<{ message: string }> | undefined;
    expect(dispatched?.detail.message).toBe("Core command queue is full");
    window.removeEventListener(EDITOR_COMMAND_FAILURE_EVENT, failure);
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

  it("rejects a late exact result when its state poll crosses a project replacement", async () => {
    vi.useFakeTimers();
    let releaseState!: (response: Response) => void;
    let signalStateRequest!: () => void;
    const stateRequestStarted = new Promise<void>((resolve) => { signalStateRequest = resolve; });
    const refetch = vi.fn();
    const requestId = 95;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/builder/midi-region/update"))
        return new Response(JSON.stringify({
          accepted: true, requestId, stateSessionId: "Core A", projectEpoch: 12,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      signalStateRequest();
      return new Promise<Response>((resolve) => { releaseState = resolve; });
    });
    vi.stubGlobal("fetch", fetch);
    registerRefetchHandler(refetch);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    const pending = builder.midiRegionUpdate({
      songIndex: 0, regionId: "stable-id-reused-in-new-project", name: "Old project result",
    });
    await stateRequestStarted;
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 13 });
    releaseState(new Response(JSON.stringify({
      stateSessionId: "Core A",
      projectEpoch: 12,
      stateRevision: 91,
      editorCommandResults: [{
        requestId, applied: true, projectEpoch: 12, projectRevision: 91,
        playbackApplied: true, playbackProjectEpoch: 6, playbackRevision: 91,
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(pending).rejects.toThrow("Project changed while confirming the edit");
    await vi.advanceTimersByTimeAsync(50);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/v1/builder/midi-region/update"),
    )).toHaveLength(1);
  });
});
