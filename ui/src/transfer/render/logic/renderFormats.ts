/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { AudioRenderOptions } from "@/lib/state/api";

export type RenderFormat = NonNullable<AudioRenderOptions["outputFormat"]>;
export type RenderBitDepth = "16" | "24" | "32";

interface FormatProfile {
  label: string;
  extension: string;
  /** A codec badge distinguishes encoders that share a file extension. */
  codec?: string;
  section: string;
  /** The final encoder accepts these output rates, not just the staging WAV. */
  rates: readonly number[];
  bitDepths: readonly RenderBitDepth[];
  description: string;
  /** Approximate compressed payload rate; VBR/headers make this an estimate. */
  bytesPerSecond?: number;
}

const PCM_RATES = [44100, 48000, 88200, 96000, 192000] as const;
const INTEGER_BITS = ["16", "24"] as const;
const PCM_BITS = ["16", "24", "32"] as const;

/** Keep encoder profiles aligned with MainComponentRender's final FFmpeg pass. */
export const RENDER_FORMATS = {
  wav: { label: "WAV", extension: ".wav", section: "Uncompressed", rates: PCM_RATES, bitDepths: PCM_BITS,
    description: "Uncompressed PCM or 32-bit float." },
  aiff: { label: "AIFF", extension: ".aiff", section: "Uncompressed", rates: PCM_RATES, bitDepths: PCM_BITS,
    description: "Uncompressed PCM or 32-bit float." },
  flac: { label: "FLAC", extension: ".flac", section: "Lossless", rates: PCM_RATES, bitDepths: INTEGER_BITS,
    description: "Lossless compression, level 8." },
  alac: { label: "M4A", extension: ".m4a", codec: "ALAC", section: "Lossless", rates: PCM_RATES, bitDepths: INTEGER_BITS,
    description: "Apple Lossless audio in an M4A container." },
  mp3: { label: "MP3", extension: ".mp3", section: "Compressed", rates: [44100, 48000], bitDepths: [],
    description: "LAME high-quality variable bitrate (VBR quality 2).", bytesPerSecond: 24000 },
  m4a: { label: "M4A", extension: ".m4a", codec: "AAC", section: "Compressed", rates: [44100, 48000, 88200, 96000], bitDepths: [],
    description: "AAC at 256 kbps in an M4A container.", bytesPerSecond: 32000 },
  opus: { label: "Opus", extension: ".opus", section: "Compressed", rates: [48000], bitDepths: [],
    description: "Opus at 160 kbps VBR. Output uses the codec's 48 kHz rate.", bytesPerSecond: 20000 },
  ogg: { label: "OGG", extension: ".ogg", codec: "Vorbis", section: "Compressed", rates: PCM_RATES, bitDepths: [],
    description: "Vorbis variable bitrate, quality 5.", bytesPerSecond: 24000 },
  wma: { label: "WMA", extension: ".wma", section: "Compressed", rates: [44100, 48000], bitDepths: [],
    description: "Windows Media Audio 2 at 192 kbps.", bytesPerSecond: 24000 },
} satisfies Record<RenderFormat, FormatProfile>;

export const RENDER_FORMAT_OPTIONS = (Object.keys(RENDER_FORMATS) as RenderFormat[]).map((id) => {
  const profile: FormatProfile = RENDER_FORMATS[id];
  return { id, label: profile.extension, section: profile.section,
    textValue: [profile.extension, profile.codec].filter(Boolean).join(" ") };
});

export function renderFormatProfile(format: RenderFormat): FormatProfile {
  return RENDER_FORMATS[format];
}

/** Resolve an unavailable rate/depth when switching formats, before submission. */
export function resolveRenderEncoding(format: RenderFormat, rate: string, depth: RenderBitDepth) {
  const profile = renderFormatProfile(format);
  const sampleRate = profile.rates.includes(Number(rate)) ? rate : "48000";
  const bitDepth = profile.bitDepths.length && !profile.bitDepths.includes(depth) ? "24" : depth;
  return { sampleRate, bitDepth };
}

export function estimatedRenderBytes(format: RenderFormat, seconds: number, files: number,
  sampleRate: number, bitDepth: RenderBitDepth) {
  const profile = renderFormatProfile(format);
  // Lossless estimates use uncompressed size; signal entropy is not known yet.
  const bytesPerSecond = profile.bytesPerSecond ?? sampleRate * 2 * Number(bitDepth) / 8;
  return Math.max(0, seconds) * Math.max(0, files) * bytesPerSecond;
}
