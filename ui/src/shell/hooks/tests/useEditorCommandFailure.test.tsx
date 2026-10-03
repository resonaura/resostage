/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppFooter } from "@/shell/components/AppFooter";
import { useEditorCommandFailure } from "@/shell/hooks/useEditorCommandFailure";
import { builder, clearApiCaches, observeProjectCommandIdentity } from "@/lib/state/api";
import { setRemoteBackend } from "@/lib/state/backend";
import type { WebUiState } from "@/lib/state/types";

describe("editor command failure recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    setRemoteBackend(null);
    window.history.replaceState({}, "", "/?embedded=1");
    clearApiCaches();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a last-good audio-graph failure and does not resend the edit", async () => {
    const message = "Project edit was stored, but its audio snapshot could not be published";
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/v1/builder/midi-region/update")) {
        return new Response(JSON.stringify({
          accepted: true,
          requestId: 91,
          stateSessionId: "Core A",
          projectEpoch: 12,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        stateSessionId: "Core A",
        projectEpoch: 12,
        stateRevision: 89,
        playbackProjectEpoch: 6,
        playbackProjectRevision: 88,
        editorCommandResults: [{
          requestId: 91,
          applied: true,
          projectEpoch: 12,
          projectRevision: 89,
          error: message,
          playbackApplied: false,
          playbackProjectEpoch: 6,
          playbackRevision: 88,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 12 });

    function Harness() {
      const failure = useEditorCommandFailure();
      return createElement(AppFooter, {
        state: { statusMessage: "Ready" } as WebUiState,
        commandFailure: failure,
      });
    }

    act(() => root.render(createElement(Harness)));

    await act(async () => {
      await expect(builder.midiRegionUpdate({
        songIndex: 0,
        regionId: "region-1",
        name: "Stored but not audible yet",
      })).rejects.toThrow(message);
    });

    const liveMessage = container.querySelector('[aria-live="polite"]');
    expect(liveMessage?.textContent).toBe(message);
    expect(liveMessage?.className).toContain("text-danger");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
