/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  RENDER_FORMAT_OPTIONS, estimatedRenderBytes, renderFormatProfile, resolveRenderEncoding,
} from "@/transfer/render/logic/renderFormats";

describe("audio export format profiles", () => {
  it("offers every Core encoder, keeping WAV first and ALAC distinct from AAC", () => {
    expect(RENDER_FORMAT_OPTIONS.map((option) => option.id)).toEqual([
      "wav", "aiff", "flac", "alac", "mp3", "m4a", "opus", "ogg", "wma",
    ]);
    expect(renderFormatProfile("alac").section).toBe("Lossless");
    expect(renderFormatProfile("m4a").section).toBe("Compressed");
    expect(renderFormatProfile("alac").extension).toBe(".m4a");
    expect(renderFormatProfile("m4a").extension).toBe(".m4a");
    expect(renderFormatProfile("alac").codec).toBe("ALAC");
    expect(renderFormatProfile("m4a").codec).toBe("AAC");
    expect(RENDER_FORMAT_OPTIONS.every((option) => /^\.[a-z0-9]+$/.test(option.label))).toBe(true);
    expect(RENDER_FORMAT_OPTIONS.find((option) => option.id === "alac")?.textValue).toBe(".m4a ALAC");
  });

  it("limits final output rates and depths without silently labeling resampled audio", () => {
    expect(resolveRenderEncoding("mp3", "192000", "32").sampleRate).toBe("48000");
    expect(resolveRenderEncoding("opus", "44100", "24").sampleRate).toBe("48000");
    expect(resolveRenderEncoding("m4a", "96000", "24").sampleRate).toBe("96000");
    expect(resolveRenderEncoding("alac", "192000", "32")).toEqual({ sampleRate: "192000", bitDepth: "24" });
    expect(resolveRenderEncoding("aiff", "192000", "32").bitDepth).toBe("32");
    expect(renderFormatProfile("flac").bitDepths).toEqual(["16", "24"]);
    expect(renderFormatProfile("mp3").bitDepths).toEqual([]);
  });

  it("estimates the selected encoder instead of always presenting a WAV size", () => {
    expect(estimatedRenderBytes("wav", 10, 2, 48000, "24")).toBe(5_760_000);
    expect(estimatedRenderBytes("m4a", 10, 2, 48000, "24")).toBe(640_000);
    expect(estimatedRenderBytes("mp3", -10, 2, 48000, "24")).toBe(0);
  });
});
