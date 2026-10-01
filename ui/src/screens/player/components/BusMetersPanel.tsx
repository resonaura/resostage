/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { ScrollShadow, Separator, Tooltip } from "@heroui/react";
import { Gauge, LayoutGrid, Rows3, SignalHigh } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { LevelMeterBar, VUMeter } from "@/components/daw";
import { rowsSameExceptLevels } from "@/lib/audio/levelFields";
import { getLiveLevels } from "@/lib/audio/liveLevels";
import { useThemeVersion } from "@/hooks/useThemeVersion";
import { Card, ToggleButton, ToggleButtonGroup } from "@/components/ui";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type BusRow,
  type Click,
  type MeterRow,
  type WebUiState,
} from "@/lib/state/types";
import { busMeterGroups, type BusMeterGroup } from "@/screens/player/logic/busMeterGroups";

type BusMeterMode = "bars" | "vu";

/**
 * How much fits on screen at once.
 *
 * "comfortable" is the original layout: full-size meters in a single row that
 * scrolls sideways. It reads well from a metre away, which is what matters
 * with four or five busses.
 *
 * "compact" trades size for count -- meters shrink and wrap, and the panel
 * scrolls VERTICALLY instead. A rig with a master, four sends and a dozen
 * output lanes is unusable as one long horizontal strip; nothing past the
 * third meter is ever on screen.
 */
type BusMeterDensity = "comfortable" | "compact";

const BUS_METER_MODE_KEY = "resostage.player.busMeterMode";
const BUS_METER_DENSITY_KEY = "resostage.player.busMeterDensity";

function readBusMeterMode(): BusMeterMode {
  try {
    const saved = localStorage.getItem(BUS_METER_MODE_KEY);
    if (saved === "bars" || saved === "vu") return saved;
  } catch {
    /* private mode */
  }
  return "vu";
}

function readBusMeterDensity(): BusMeterDensity {
  try {
    const saved = localStorage.getItem(BUS_METER_DENSITY_KEY);
    if (saved === "comfortable" || saved === "compact") return saved;
  } catch {
    /* private mode */
  }
  return "comfortable";
}

// Memoized on exactly the four wire arrays the grouping depends on, and
// compared BY CONTENT rather than by identity -- see the comparator below.
//
// The comment that used to sit here claimed all four keep their identity
// across frames "while the routing holds still". That is true of `busses` and
// `tracks`, and false of `meters`: every MeterRow carries the peaks, so the
// array is rebuilt on every telemetry frame and the memo never once hit. The
// panel -- and the grouping recomputed inside it -- was being re-rendered at
// telemetry rate to show levels its meters were already reading for
// themselves through getLiveLevels() during their own canvas paint.
const BusMetersPanelInner = memo(function BusMetersPanel({
  meters,
  busses,
  tracks,
  click,
}: {
  meters: MeterRow[];
  busses: BusRow[];
  tracks: WebUiState["tracks"];
  click?: Click;
}) {
  const [mode, setMode] = useState<BusMeterMode>(readBusMeterMode);
  const [density, setDensity] = useState<BusMeterDensity>(readBusMeterDensity);
  useEffect(() => {
    try {
      localStorage.setItem(BUS_METER_MODE_KEY, mode);
    } catch {
      /* best-effort */
    }
  }, [mode]);
  useEffect(() => {
    try {
      localStorage.setItem(BUS_METER_DENSITY_KEY, density);
    } catch {
      /* best-effort */
    }
  }, [density]);
  const compact = density === "compact";
  // Group accents are resolved hex, so a theme swap must recompute them --
  // and this panel is memoised on props that a theme change does not touch,
  // so the hook is also what makes it re-render at all. See useThemeVersion.
  const themeVersion = useThemeVersion();
  const groups = useMemo(
    () =>
      busMeterGroups(
        meters,
        busses,
        tracks,
        click ? sourceOutputBusId(click.output) : undefined,
        click ? outputSendsToClickRows(click.output) : undefined,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meters, busses, tracks, click, themeVersion],
  );

  // The needle, not the last callback's peak: the engine's interval peak, so
  // the VU reads the same at 512 frames and at 4096. See lib/liveLevels.
  const vuGetterFor = (g: BusMeterGroup) => () => {
    let mx = -Infinity;
    const levels = getLiveLevels().meters;
    if (!levels.length) return -144;
    for (const m of g.meters) {
      for (const lm of levels) {
        if (lm.id === m.id) {
          const a = lm.needleDbL ?? -144;
          const b = lm.needleDbR ?? -144;
          if (a > mx) mx = a;
          if (b > mx) mx = b;
        }
      }
    }
    return mx === -Infinity ? -144 : mx;
  };

  return (
    <Card className="flex md:w-100 h-56 min-h-0 shrink-0 flex-col overflow-hidden sm:w-unset sm:h-auto p-0 gap-0">
      <Card.Header className="h-10 flex flex-row items-center justify-between border-b border-default/20 px-3.5 space-y-0 shrink-0">
        <span className="text-[11px] mr-5 font-bold uppercase tracking-widest text-foreground/35">
          Bus meters
        </span>
        {/* Two independent single-selects: what the meters look like, and how
            many of them fit. Both are exclusive and neither may be emptied. */}
        <div className="flex items-center gap-2">
          <ToggleButtonGroup
            aria-label="Meter style"
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[mode]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0] as BusMeterMode | undefined;
              if (next) setMode(next);
            }}
          >
            <Tooltip>
              <ToggleButton id="bars" isIconOnly aria-label="Bar meters">
                <SignalHigh size={14} />
              </ToggleButton>
              <Tooltip.Content>Bar meters</Tooltip.Content>
            </Tooltip>
            <Tooltip>
              <ToggleButton id="vu" isIconOnly aria-label="VU meters">
                <ToggleButtonGroup.Separator />
                <Gauge size={14} />
              </ToggleButton>
              <Tooltip.Content>VU meters</Tooltip.Content>
            </Tooltip>
          </ToggleButtonGroup>
          <Separator orientation="vertical" className="h-4 mt-auto mb-auto" />
          <ToggleButtonGroup
            aria-label="Meter density"
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[density]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0] as BusMeterDensity | undefined;
              if (next) setDensity(next);
            }}
          >
            <Tooltip>
              <ToggleButton
                id="comfortable"
                isIconOnly
                aria-label="Comfortable"
              >
                <Rows3 size={14} />
              </ToggleButton>
              <Tooltip.Content>
                Comfortable — full size, scrolls sideways
              </Tooltip.Content>
            </Tooltip>
            <ToggleButtonGroup.Separator />
            <Tooltip>
              <ToggleButton id="compact" isIconOnly aria-label="Compact">
                <ToggleButtonGroup.Separator />
                <LayoutGrid size={14} />
              </ToggleButton>
              <Tooltip.Content>
                Compact — fits more, scrolls vertically
              </Tooltip.Content>
            </Tooltip>
          </ToggleButtonGroup>
        </div>
      </Card.Header>

      {groups.length === 0 ? (
        <div className="flex h-full items-center justify-center py-4 text-sm text-foreground/40">
          No busses.
        </div>
      ) : mode === "vu" ? (
        <ScrollShadow
          orientation={compact ? "vertical" : "horizontal"}
          className={
            compact
              ? "flex min-h-0 flex-1 flex-wrap content-start justify-center gap-2 p-2"
              : "flex min-h-0 flex-1 items-center gap-4 p-3"
          }
        >
          {groups.map((g) => {
            const db = Math.max(...g.meters.map((m) => m.peakDb));
            return (
              <div
                key={g.id}
                className={
                  compact
                    ? "flex h-22 w-26 shrink-0 items-center"
                    : "flex h-full w-44 shrink-0 items-center"
                }
              >
                <VUMeter
                  name={g.name}
                  db={db}
                  getDb={vuGetterFor(g)}
                  color={g.accent}
                />
              </div>
            );
          })}
        </ScrollShadow>
      ) : (
        <ScrollShadow
          orientation={compact ? "vertical" : "horizontal"}
          className={
            compact
              ? "flex min-h-0 flex-1 flex-wrap content-start justify-center gap-x-2 gap-y-1 p-2"
              : "flex min-h-0 flex-1 items-center gap-3 p-4"
          }
        >
          {groups.map((g) => {
            const m0 = g.meters[0];
            const m1 = g.meters[1];
            const db = Math.max(...g.meters.map((m) => m.peakDb));
            const dbL = m0.peakDbL ?? m0.peakDb;
            const dbR = m1
              ? (m1.peakDbR ?? m1.peakDb)
              : (m0.peakDbR ?? m0.peakDb);
            const lufs = Math.max(...g.meters.map((m) => m.shortTermLufs));
            const live0 = () =>
              getLiveLevels().meters.find((lm) => lm.id === m0.id);
            const live1 = () =>
              m1
                ? getLiveLevels().meters.find((lm) => lm.id === m1.id)
                : undefined;
            return (
              <div
                key={g.id}
                className={
                  compact
                    ? "flex h-26 w-17 shrink-0 flex-col items-center justify-between gap-0.5"
                    : "flex h-full flex-col items-center justify-between gap-1.5 py-1"
                }
              >
                <div
                  className={`truncate text-center font-semibold text-foreground/80 ${
                    compact ? "w-16 text-[10px]" : "w-18 text-xs"
                  }`}
                  title={g.name}
                >
                  {g.name}
                </div>
                <div className="flex h-full min-h-0 flex-1 items-center justify-center">
                  <LevelMeterBar
                    db={db}
                    dbL={dbL}
                    dbR={dbR}
                    getLiveDbL={() => live0()?.needleDbL ?? -144}
                    getLiveDbR={() =>
                      m1
                        ? (live1()?.needleDbR ?? -144)
                        : (live0()?.needleDbR ?? -144)
                    }
                    accent={g.accent}
                    vertical={true}
                    showValue={false}
                    className="h-full"
                    barClassName={compact ? "h-full w-1" : "h-full w-1.5"}
                  />
                </div>
                <div
                  className={`text-center tabular-nums text-foreground/50 ${
                    compact ? "text-[9px]" : "text-[10px]"
                  }`}
                >
                  <div
                    className={
                      db > -3
                        ? "text-danger font-bold"
                        : db > -9
                          ? "text-warning font-semibold"
                          : ""
                    }
                  >
                    {db <= -99 ? "−∞" : db.toFixed(1)} dB
                  </div>
                  {/* LUFS is the first thing to go when space is tight -- peak
                      is what you glance at during a show. */}
                  {!compact && (
                    <div className="text-[9px] text-foreground/35">
                      {lufs <= -144 ? "−∞ L" : `${lufs.toFixed(1)} L`}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </ScrollShadow>
      )}
    </Card>
  );
});

/**
 * Re-render only when the ROUTING behind the meters changes, never because a
 * level moved. `meters` is compared field-by-field with the peaks excluded;
 * the other three keep their identity through structural sharing, so a plain
 * reference check is exact for them. See lib/levelFields.
 */
export const BusMetersPanel = memo(
  BusMetersPanelInner,
  (prev, next) =>
    prev.busses === next.busses &&
    prev.tracks === next.tracks &&
    prev.click === next.click &&
    rowsSameExceptLevels(prev.meters, next.meters),
);
