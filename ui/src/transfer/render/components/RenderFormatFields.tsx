/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Select } from "@/components/ui";
import type { ReactNode } from "react";
import { Section } from "@/transfer/render/components/RenderFields";
import { RenderFormatLabel } from "@/transfer/render/components/RenderFormatLabel";
import {
  RENDER_FORMAT_OPTIONS, renderFormatProfile, resolveRenderEncoding,
  type RenderBitDepth, type RenderFormat,
} from "@/transfer/render/logic/renderFormats";

const FORMAT_OPTIONS = RENDER_FORMAT_OPTIONS.map((option) => ({
  ...option, label: <RenderFormatLabel format={option.id} />,
}));

/** The selects have explicit accessible labels. Do not wrap their portalled
 * options in a native label: its click forwarding can reopen a closed picker.
 */
function FormatField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-render-field className="min-w-0 space-y-1">
      <span className="block whitespace-nowrap text-[10px] font-semibold uppercase text-foreground/45">
        {label}
      </span>
      {children}
    </div>
  );
}

/** Format controls describe the exported file, not the private float-WAV stage. */
export function RenderFormatFields({ format, sampleRate, bitDepth, onChange }: {
  format: RenderFormat;
  sampleRate: string;
  bitDepth: RenderBitDepth;
  onChange: (format: RenderFormat, sampleRate: string, bitDepth: RenderBitDepth) => void;
}) {
  const profile = renderFormatProfile(format);
  return (
    <Section title="File format">
      <div className="grid grid-cols-2 gap-3">
        <FormatField label="Format">
          <Select size="sm" aria-label="Export file format" value={format}
            options={FORMAT_OPTIONS}
            onChange={(value) => {
              const next = value as RenderFormat;
              const encoding = resolveRenderEncoding(next, sampleRate, bitDepth);
              onChange(next, encoding.sampleRate, encoding.bitDepth);
            }} />
        </FormatField>
        <FormatField label="Sample rate">
          <Select size="sm" aria-label="Export sample rate" value={sampleRate}
            onChange={(rate) => onChange(format, rate, bitDepth)}
            options={profile.rates.map((rate) => ({ id: String(rate), label: `${rate / 1000} kHz` }))} />
        </FormatField>
        {profile.bitDepths.length > 0 && (
          <FormatField label="Encoding">
            <Select size="sm" aria-label="Export encoding" value={bitDepth}
              onChange={(depth) => onChange(format, sampleRate, depth as RenderBitDepth)}
              options={profile.bitDepths.map((depth) => ({
                id: depth, label: `${depth}-bit ${depth === "32" ? "float" : "PCM"}`,
              }))} />
          </FormatField>
        )}
      </div>
      <p className="text-[10px] text-foreground/55">{profile.description}</p>
    </Section>
  );
}
