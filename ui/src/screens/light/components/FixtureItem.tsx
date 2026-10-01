// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { Tooltip } from "@heroui/react";
import { Trash2, TriangleAlert } from "lucide-react";
import type { ComponentType } from "react";
import { useLiveFixtureColor } from "@/screens/light/hooks/useLiveFixtureColor";
import type { LightFixtureRow } from "@/lib/state/types";
import type { PreviewColor } from "@/screens/light/components/LazyResoLightStage3D";
import { Button, ToggleButton } from "@/components/ui";
// ─── Fixture row ──────────────────────────────────────────────────────────

/**
 * Collapses a preview color (possibly a live per-LED array, straight off
 * the same backend websocket stream the Timeline's Light mode reads -- see
 * ProjectLightingPanel's displayColors) into one flat r/g/b/intensity for
 * this row's single swatch dot, which has no notion of per-LED detail.
 */
function summarizeSwatchColor(
  c?: PreviewColor,
): { r: number; g: number; b: number; intensity: number } | undefined {
  if (!c) return undefined;
  if (!c.ledColors || c.ledColors.length === 0) return c;
  let r = 0,
    g = 0,
    b = 0;
  for (const led of c.ledColors) {
    r += led.r;
    g += led.g;
    b += led.b;
  }
  const n = c.ledColors.length;
  r = Math.round(r / n);
  g = Math.round(g / n);
  b = Math.round(b / n);
  return { r, g, b, intensity: Math.max(r, g, b) / 255 };
}

/**
 * One row of the fixture list: a ToggleButton carrying the selection (the
 * whole list is one single-selection ToggleButtonGroup) plus its own remove
 * button as a sibling, since a button inside a button is not a thing.
 */
export function FixtureItem({
  fixture,
  fixtureIndex,
  live,
  onRemove,
  hasChannelConflict,
  shapeIcon: ShapeIcon,
}: {
  fixture: LightFixtureRow;
  fixtureIndex: number;
  live: boolean;
  onRemove: () => void;
  hasChannelConflict: boolean;
  shapeIcon: ComponentType<{ size?: number; className?: string }> | null;
}) {
  const previewColor = summarizeSwatchColor(
    useLiveFixtureColor(fixtureIndex, live),
  );
  const hasColor = previewColor && previewColor.intensity > 0.01;
  return (
    <div className="flex w-full items-center gap-1">
      <ToggleButton
        id={fixture.id}
        variant="ghost"
        className={`min-w-0 flex-1 justify-start gap-2.5 ${
          hasChannelConflict ? "border border-warning" : ""
        }`}
      >
        {/* Live color dot */}
        <span
          className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/10 transition-colors"
          style={{
            background: hasColor
              ? `rgb(${previewColor.r},${previewColor.g},${previewColor.b})`
              : "#334155",
            boxShadow: hasColor
              ? `0 0 6px rgb(${previewColor.r},${previewColor.g},${previewColor.b})`
              : "none",
          }}
        />
        {ShapeIcon && <ShapeIcon size={11} className="shrink-0 text-muted" />}
        <span className="flex-1 truncate text-left text-xs font-medium">
          {fixture.name}
        </span>
        {fixture.kind === "resolight::bar" && fixture.networkHost ? (
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              fixture.hwConnected ? "bg-success" : "bg-default"
            }`}
            title={
              fixture.hwConnected
                ? `Hardware linked · ${fixture.networkHost}`
                : `Hardware configured · ${fixture.networkHost} (not linked)`
            }
          />
        ) : null}
        {hasChannelConflict && (
          <TriangleAlert
            size={11}
            className="shrink-0 text-warning"
            aria-label="DMX channel conflict"
          />
        )}
        <span
          className={`shrink-0 font-mono text-[9px] ${
            hasChannelConflict ? "text-warning" : "text-muted"
          }`}
          title={
            hasChannelConflict
              ? "Overlaps another fixture's DMX channels"
              : undefined
          }
        >
          {fixture.kind === "dmx::generic"
            ? `U${fixture.dmx.universe}:${fixture.dmx.startChannel}`
            : `${fixture.ledCount}L · ${fixture.mountedHorizontally ? "H" : "V"}${fixture.addressable ? " · addr" : ""}`}
        </span>
      </ToggleButton>
      <Tooltip>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={`Remove ${fixture.name}`}
          onPress={onRemove}
        >
          <Trash2 size={12} />
        </Button>
        <Tooltip.Content>Remove fixture</Tooltip.Content>
      </Tooltip>
    </div>
  );
}
