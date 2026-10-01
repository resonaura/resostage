import { useState } from "react";
import { Knob } from "@/components/daw";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "@/components/common/ContextMenu";
import { mixer } from "@/lib/state/api";
import { useLiveValue } from "@/lib/state/optimistic";
import type { TrackRow } from "@/lib/state/types";

const PAN_LAWS = [
  { id: 0, value: "0dB", label: "0 dB · Legacy balance" },
  { id: 1, value: "-3dB", label: "−3 dB · Constant power" },
  { id: 2, value: "-4.5dB", label: "−4.5 dB · Broadcast" },
  { id: 3, value: "-6dB", label: "−6 dB · Constant voltage" },
] as const;

function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.05) return "C";
  if (pan < 0) return `L${Math.round(-pan * 100)}`;
  return `R${Math.round(pan * 100)}`;
}

/** Track panning control, including its context-menu-selected pan law. */
export function TrackPanControl({
  track,
  index,
  color,
  knobSize,
  laneHeight,
}: {
  track: TrackRow;
  index: number;
  color: string;
  knobSize: number;
  laneHeight: number;
}) {
  const [pan, setPan] = useLiveValue(track.pan ?? 0, (value) =>
    mixer.setTrackPan(index, value),
  );
  const [panLawMenu, setPanLawMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const activePanLaw = track.panLaw ?? "0dB";

  return (
    <div
      className="flex shrink-0 items-center gap-0.5"
      title={`Pan: ${formatPan(pan)} · ${activePanLaw} pan law (right-click to change)`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setPanLawMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <Knob
        value={pan}
        min={-1}
        max={1}
        defaultValue={0}
        size={knobSize}
        accent={color}
        onCommit={(value) => setPan(value)}
      />
      {laneHeight >= 52 && (
        <span className="w-4 text-center font-mono font-medium text-foreground/50 text-[8px]">
          {formatPan(pan)}
        </span>
      )}
      {panLawMenu && (
        <ContextMenu
          x={panLawMenu.x}
          y={panLawMenu.y}
          width={232}
          onClose={() => setPanLawMenu(null)}
        >
          <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-foreground/45">
            Pan law · {track.name || track.id}
          </div>
          {PAN_LAWS.map((law) => (
            <ContextMenuItem
              key={law.value}
              checked={activePanLaw === law.value}
              radio
              onClick={() => {
                void mixer.setTrackPanLaw(index, law.id);
                setPanLawMenu(null);
              }}
            >
              {law.label}
            </ContextMenuItem>
          ))}
          <ContextMenuDivider />
          <div className="px-2.5 py-1.5 text-[10px] leading-snug text-foreground/45">
            Right-click the pan knob to choose how its center level is compensated.
          </div>
        </ContextMenu>
      )}
    </div>
  );
}
