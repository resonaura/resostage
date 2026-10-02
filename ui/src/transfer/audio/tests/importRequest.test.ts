/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importMediaFile } from "@/transfer/audio/logic/importRequest";
import { apiFetch, backendOrigin, type ApiResponse } from "@/lib/state/backend";

vi.mock("@/lib/state/backend", () => ({ apiFetch: vi.fn(), backendOrigin: vi.fn(() => "localhost:2899") }));

const response = (payload: unknown, ok = true, status = 200): ApiResponse => ({
  ok, status, json: async <T,>() => payload as T, text: async () => JSON.stringify(payload),
});

beforeEach(() => { vi.useFakeTimers(); vi.mocked(backendOrigin).mockReturnValue("localhost:2899"); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("media import completion", () => {
  it("waits for Core commit and correlates all calls with the same ticket", async () => {
    const fetch = vi.mocked(apiFetch);
    fetch.mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ finished: false, success: false, error: "" }))
      .mockResolvedValueOnce(response({ finished: true, success: true, error: "" }));
    const file = new File([new Uint8Array([0, 255, 128])], "video.mov", { type: "video/quicktime" });
    let committed = false;
    const promise = importMediaFile(2, 4, file, 1.5).then(() => { committed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toBe(false);
    const target = JSON.parse(fetch.mock.calls[0][1]?.body as string);
    expect(target).toMatchObject({ songIndex: 2, index: 4, fileName: "video.mov", startSeconds: 1.5 });
    expect(fetch.mock.calls[1]).toEqual([
      `/api/v1/builder/track/import-wav/upload?requestId=${target.requestId}`, { method: "POST", body: file },
    ]);
    await vi.advanceTimersByTimeAsync(250);
    await promise;
    expect(committed).toBe(true);
    expect(fetch.mock.calls[3][0]).toContain(target.requestId);
  });

  it("reports conversion failure instead of treating the upload acknowledgement as success", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ finished: true, success: false, error: "No audio stream" }));
    await expect(importMediaFile(0, 0, new File(["video"], "silent.mov"))).rejects.toThrow("No audio stream");
  });

  it("sends the captured Core project identity with both ticket and media bytes", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ finished: true, success: true, error: "" }));
    const identity = {
      "X-ResoStage-Session": "Core session",
      "X-ResoStage-Project-Epoch": "5",
    };
    await importMediaFile(0, 1, new File(["audio"], "take.mov"), 2, identity);
    expect(apiFetch).toHaveBeenNthCalledWith(1, "/api/v1/builder/track/import-wav/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...identity },
      body: expect.any(String),
    });
    expect(apiFetch).toHaveBeenNthCalledWith(2,
      expect.stringMatching(/^\/api\/v1\/builder\/track\/import-wav\/upload\?requestId=/),
      { method: "POST", headers: identity, body: expect.any(File) });
  });

  it("does not upload after an invalid/rejected target", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(response({ error: "Queue full" }, false, 409));
    await expect(importMediaFile(0, 0, new File(["a"], "a.wav"))).rejects.toThrow("Queue full");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
