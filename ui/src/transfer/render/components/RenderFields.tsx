// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import type { ReactNode } from "react";
import { Button } from "@/components/ui";
import type { AudioRenderStatus } from "@/lib/state/api";
import { formatDuration } from "@/transfer/render/logic/renderModel";

export function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-foreground/55">
          {title}
        </h3>
        {aside && (
          <span className="text-[10px] text-foreground/40">{aside}</span>
        )}
      </div>
      {children}
    </section>
  );
}

export function Choice({
  active,
  disabled,
  onPress,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={active ? "accent-soft" : "outline"}
      isDisabled={disabled}
      onPress={onPress}
      className="w-full"
    >
      {children}
    </Button>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="space-y-1">
      <span className="block text-[10px] font-semibold uppercase text-foreground/45">
        {label}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  "h-8 w-full rounded-lg border border-default/30 bg-default/20 px-3 text-xs outline-none focus:border-accent disabled:opacity-40";

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.001,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
    </Field>
  );
}

export function SummaryRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-foreground/45">{label}</span>
      <span className="max-w-40 text-right font-semibold">{value}</span>
    </div>
  );
}

export function RenderProgress({ status }: { status: AudioRenderStatus }) {
  return (
    <div className="space-y-2 rounded-lg border border-default/20 bg-surface/60 p-3">
      {status.state === "rendering" && (
        <>
          <div className="flex justify-between text-[10px]">
            <span className="capitalize">{status.phase ?? "Rendering"}</span>
            <span>{Math.round(status.progress * 100)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-default/25">
            <div
              className="h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${Math.round(status.progress * 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-foreground/45">
            <span>
              {(status.processingSpeedMultiplier ?? 0) > 0
                ? `${status.processingSpeedMultiplier?.toFixed(1)}× realtime`
                : "Measuring speed…"}
            </span>
            <span>
              {(status.estimatedRemainingSeconds ?? 0) > 0
                ? `${formatDuration(status.estimatedRemainingSeconds ?? 0)} left`
                : ""}
            </span>
          </div>
        </>
      )}
      {status.state === "complete" && (
        <>
          <div className="text-xs font-semibold text-success">Render complete</div>
          <div className="max-h-28 space-y-1 overflow-y-auto">
            {(status.outputPaths?.length
              ? status.outputPaths
              : [status.outputPath]
            ).map((path) => (
              <div
                key={path}
                className="break-all font-mono text-[9px] text-foreground/55"
              >
                {path}
              </div>
            ))}
          </div>
          {status.warnings?.map((warning) => (
            <div
              key={warning}
              className="rounded bg-warning/10 px-2 py-1 text-[9px] text-warning"
            >
              {warning}
            </div>
          ))}
        </>
      )}
      {status.state === "cancelled" && (
        <div className="text-xs text-warning">
          Render cancelled. Partial files were removed.
        </div>
      )}
      {status.state === "failed" && (
        <div className="text-xs text-danger">
          {status.error || "Render failed"}
        </div>
      )}
    </div>
  );
}
