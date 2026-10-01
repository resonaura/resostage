/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import {
  Button,
  Select,
  type SelectOption,
} from "@/components/ui";
import { useLiveValue } from "@/lib/state/optimistic";
import type { PluginSlotRow } from "@/lib/state/types";
import { ROUTING_SELECT_SIZE } from "@/screens/mixer/logic/constants";
import { MonoStereoIcon } from "@/screens/mixer/strips/MonoStereoIcon";
import { PluginSlotControl } from "@/screens/mixer/plugins/PluginSlotControl";
import { createVerticalValueDragHandler } from "@/screens/mixer/strips/logic/verticalValueDrag";

/** Stable identity so useLiveValue's commit ref doesn't churn. */
const noop = () => {};

export type StripFormatToggle = {
  stereo: boolean;
  onToggle: () => void;
};

export type StripInputRouting = {
  isInstrument: boolean;
  instrumentName?: string | null;
  instrumentSlotId?: string;
  instrumentBypassed?: boolean;
  instrumentLoadState?: PluginSlotRow["loadState"];
  instrumentLoadError?: string;
  onRetryInstrument?: () => void;
  onToggleInstrumentBypass?: () => void;
  onOpenInstrument?: () => void;
  onInstrumentMenu?: (pos: { x: number; y: number }) => void;
  inputOptions?: SelectOption[];
  currentInput?: string;
  onInputChange?: (source: string) => void;
  polarity?: "none" | "left" | "right" | "both";
  onTogglePolarity?: () => void;
  onPolarityMenu?: (pos: { x: number; y: number }) => void;
  trimDb?: number;
  onTrimChange?: (trim: number) => void;
};

export function StripInputControls({
  color,
  isNarrow,
  formatToggle,
  inputRouting,
}: {
  color: string;
  isNarrow: boolean;
  formatToggle?: StripFormatToggle;
  inputRouting?: StripInputRouting;
}) {
  // ── What this strip currently SHOWS, as opposed to what the engine has
  // last confirmed ────────────────────────────────────────────────────────
  const [displayTrimDb, commitTrimDb] = useLiveValue(
    inputRouting?.trimDb ?? 0,
    inputRouting?.onTrimChange ?? noop,
  );

  const handleTrimPointerDown = createVerticalValueDragHandler(
    displayTrimDb,
    commitTrimDb,
    {
      min: -24,
      max: 24,
      sensitivity: 0.15,
      step: 0.1,
      fineSensitivity: 0.02,
      fineStep: 0.05,
      precision: 2,
      capturePointer: true,
    },
  );
  const isPolarityActive =
    inputRouting?.polarity && inputRouting.polarity !== "none";

  if (!formatToggle && !inputRouting) return null;

  return (
    <div className="my-1 flex w-full flex-col gap-1">
      {formatToggle && (
        <div className="my-0.5 flex w-full items-center justify-center">
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            className="size-6 min-w-0 text-foreground/60 hover:text-foreground hover:bg-surface/80"
            aria-label={
              formatToggle.stereo
                ? "Stereo (click for mono)"
                : "Mono (click for stereo)"
            }
            onPress={formatToggle.onToggle}
          >
            <MonoStereoIcon stereo={formatToggle.stereo} />
          </Button>
        </div>
      )}

      {inputRouting?.isInstrument ? (
        inputRouting.instrumentSlotId ? (
          <PluginSlotControl
            name={inputRouting.instrumentName || "Unknown instrument"}
            bypassed={!!inputRouting.instrumentBypassed}
            onOpen={() => inputRouting.onOpenInstrument?.()}
            onToggle={() => inputRouting.onToggleInstrumentBypass?.()}
            onSwap={(event) => {
              inputRouting.onInstrumentMenu?.({
                x: event.clientX,
                y: event.clientY,
              });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              inputRouting.onInstrumentMenu?.({
                x: event.clientX,
                y: event.clientY,
              });
            }}
            title={
              inputRouting.instrumentLoadError ||
              `Software Instrument: ${inputRouting.instrumentName || "none"} · ${inputRouting.instrumentLoadState || "loading"}`
            }
          />
        ) : (
          <button
            type="button"
            onClick={(event) =>
              inputRouting.onInstrumentMenu?.({
                x: event.clientX,
                y: event.clientY,
              })
            }
            onContextMenu={(event) => {
              event.preventDefault();
              inputRouting.onInstrumentMenu?.({
                x: event.clientX,
                y: event.clientY,
              });
            }}
            className="flex h-5.5 w-full min-w-0 items-center rounded border border-dashed px-1.5 text-left text-xs font-semibold text-foreground/55 transition-colors hover:text-foreground/80"
            style={{
              borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
            }}
            title="Add Software Instrument"
          >
            {isNarrow ? "+ Inst" : "+ Instrument"}
          </button>
        )
      ) : inputRouting?.inputOptions && inputRouting.onInputChange ? (
        <div className="w-full min-w-0">
          <Select
            aria-label="Input routing"
            size={ROUTING_SELECT_SIZE}
            options={inputRouting.inputOptions}
            value={inputRouting.currentInput ?? ""}
            onChange={inputRouting.onInputChange}
          />
        </div>
      ) : null}

      {inputRouting?.onTogglePolarity && (
        <div className="flex w-full items-center justify-between px-0.5 text-[9px]">
          <button
            type="button"
            onClick={inputRouting.onTogglePolarity}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              inputRouting.onPolarityMenu?.({
                x: event.clientX,
                y: event.clientY,
              });
            }}
            title={
              isPolarityActive
                ? `Polarity Inverted (${inputRouting.polarity?.toUpperCase()}) — right-click for L/R options`
                : "Polarity Normal (0°) — click to invert, right-click for L/R options"
            }
            className={`flex h-4 px-1 items-center justify-center rounded border transition-colors ${
              isPolarityActive
                ? "border-(--rs-phase)/60 bg-(--rs-phase)/20 text-(--rs-phase) font-black shadow-[0_0_6px_rgba(48,209,88,0.4)]"
                : "border-default/20 text-foreground/45 hover:text-foreground/80 hover:bg-surface/50"
            }`}
            aria-label="Phase Invert"
          >
            {inputRouting.polarity === "left"
              ? "Ø L"
              : inputRouting.polarity === "right"
                ? "Ø R"
                : "Ø"}
          </button>

          <span
            className="font-mono text-foreground/50 hover:text-foreground cursor-ns-resize transition-colors select-none px-1 rounded hover:bg-surface/60"
            title="Input Trim dB (Drag up/down like a knob, Shift for fine, double-click for 0.0dB)"
            onPointerDown={handleTrimPointerDown}
            onDoubleClick={(event) => {
              event.preventDefault();
              commitTrimDb(0.0);
            }}
          >
            {displayTrimDb === 0
              ? "±0.0dB"
              : `${displayTrimDb > 0 ? "+" : ""}${displayTrimDb.toFixed(1)}dB`}
          </span>
        </div>
      )}
    </div>
  );
}
