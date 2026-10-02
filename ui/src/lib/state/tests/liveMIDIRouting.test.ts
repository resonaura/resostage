/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/state/backend";
import { registerLiveMidiSender, sendLiveMidi, unregisterLiveMidiSender } from "@/lib/state/api";

vi.mock("@/lib/state/backend", () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }), apiUrl: (path: string) => path,
  backendOrigin: () => "http://localhost:2899",
}));

describe("live MIDI destination routing", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(unregisterLiveMidiSender);

  it("retains the low-latency binary path for untargeted MIDI", () => {
    const send = vi.fn(() => true);
    registerLiveMidiSender(send);
    sendLiveMidi(0x90, 60, 127);
    expect(send).toHaveBeenCalledWith(new Uint8Array([0x90, 60, 127]));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each([0, 17])("preserves explicit track index %i even when binary WS is available", (trackIndex) => {
    const send = vi.fn(() => true);
    registerLiveMidiSender(send);
    sendLiveMidi(0x90, 64, 80, trackIndex);
    sendLiveMidi(0x80, 64, 0, trackIndex);
    expect(send).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    const messages = vi.mocked(apiFetch).mock.calls.map(([, options]) => JSON.parse(options!.body as string));
    expect(messages).toEqual([{ status: 0x90, data1: 64, data2: 80, trackIndex },
      { status: 0x80, data1: 64, data2: 0, trackIndex }]);
  });

  it("falls back to HTTP when an untargeted WS send is unavailable", () => {
    registerLiveMidiSender(() => false);
    sendLiveMidi(0xb0, 64, 0);
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/midi/send", expect.objectContaining({
      body: JSON.stringify({ status: 0xb0, data1: 64, data2: 0 }),
    }));
  });
});
