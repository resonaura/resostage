/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/** Shared loop seams used by audio and MIDI timeline regions. */
export function RegionLoopBoundaries({
  enabled,
  durationPx,
  loopLengthPx,
  color,
}: {
  enabled: boolean;
  durationPx: number;
  loopLengthPx: number;
  color: string;
}) {
  if (
    !enabled ||
    loopLengthPx <= 2 ||
    durationPx <= loopLengthPx + 2
  ) {
    return null;
  }

  return Array.from({ length: Math.floor(durationPx / loopLengthPx) }).map(
    (_, index) => {
      const x = (index + 1) * loopLengthPx;
      if (x <= 2 || x >= durationPx - 2) return null;

      return (
        <div
          key={`loop-${index}`}
          className="pointer-events-none absolute top-0 bottom-0 z-3"
          style={{ left: x }}
          title="Loop boundary"
        >
          <div
            className="absolute left-1/2 top-0 -translate-x-1/2"
            style={{
              width: 0,
              height: 0,
              borderLeft: "4px solid transparent",
              borderRight: "4px solid transparent",
              borderTop: `6px solid ${color}`,
              opacity: 0.9,
            }}
          />
          <div
            className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2"
            style={{ background: color, opacity: 0.4 }}
          />
          <div
            className="absolute left-1/2 bottom-0 -translate-x-1/2"
            style={{
              width: 0,
              height: 0,
              borderLeft: "4px solid transparent",
              borderRight: "4px solid transparent",
              borderBottom: `6px solid ${color}`,
              opacity: 0.9,
            }}
          />
        </div>
      );
    },
  );
}
