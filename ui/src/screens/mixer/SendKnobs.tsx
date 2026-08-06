import { useState } from "react";
import { ContextMenu, ContextMenuItem } from "../../components/ContextMenu";
import { SEND_FLOOR_DB, SendArcKnob } from "../../components/SendArcKnob";
import { mixer } from "../../lib/api";
import type { BusRow } from "../../lib/types";

export function SendKnobs({
  auxBusses,
  sends,
  trackIndex,
  onSendChange,
  onRemoveSend,
}: {
  auxBusses: BusRow[];
  sends: { busId: string; gainDb: number }[];
  trackIndex: number;
  onSendChange?: (busId: string, gainDb: number) => void;
  /** Real per-track sends only — omit for click (uses onSendChange + enabled). */
  onRemoveSend?: (busId: string) => void;
}) {
  const [removeMenu, setRemoveMenu] = useState<{
    x: number;
    y: number;
    busId: string;
    busName: string;
  } | null>(null);

  const [pendingRemoved, setPendingRemoved] = useState<Set<string>>(new Set());

  if (auxBusses.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-1 border-t border-default/20 py-1">
      {auxBusses.map((bus) => {
        const isPendingRemoved = pendingRemoved.has(bus.id);
        const existing = isPendingRemoved
          ? undefined
          : sends.find((s) => s.busId === bus.id);
        const value = existing?.gainDb ?? SEND_FLOOR_DB;

        return (
          <div
            key={bus.id}
            className="flex items-center justify-between gap-1 w-full px-0.5 min-w-0"
            onContextMenu={(e) => {
              // Always stop propagation so right-clicking a send row doesn't
              // trigger the outer track strip context menu (which would open
              // "Remove track" / "Rename track" over this send item).
              e.preventDefault();
              e.stopPropagation();
              if (onRemoveSend && existing) {
                setRemoveMenu({
                  x: e.clientX,
                  y: e.clientY,
                  busId: bus.id,
                  busName: bus.name || bus.id,
                });
              }
            }}
          >
            <span
              className="truncate text-[9px] font-mono font-medium min-w-0 flex-1 text-foreground/70 select-none"
              title={bus.name || bus.id}
            >
              {bus.name || bus.id}
            </span>
            <SendArcKnob
              key={bus.id}
              value={value}
              min={SEND_FLOOR_DB}
              max={6}
              busColor="rgba(255,255,255,0.9)"
              title={
                existing
                  ? `Send to ${bus.name || bus.id} (right-click to remove)`
                  : `Send to ${bus.name || bus.id}`
              }
              onChange={(v) => {
                if (pendingRemoved.has(bus.id)) {
                  setPendingRemoved((prev) => {
                    const next = new Set(prev);
                    next.delete(bus.id);
                    return next;
                  });
                }
                if (onSendChange) {
                  onSendChange(bus.id, v);
                } else {
                  mixer.setTrackSend(trackIndex, bus.id, v);
                }
              }}
            />
          </div>
        );
      })}
      {removeMenu && onRemoveSend && (
        <ContextMenu
          x={removeMenu.x}
          y={removeMenu.y}
          width={160}
          onClose={() => setRemoveMenu(null)}
        >
          <ContextMenuItem
            danger
            onClick={() => {
              const busId = removeMenu.busId;
              setPendingRemoved((prev) => new Set(prev).add(busId));
              onRemoveSend(busId);
              setRemoveMenu(null);
            }}
          >
            Remove Send to {removeMenu.busName}
          </ContextMenuItem>
        </ContextMenu>
      )}
    </div>
  );
}
