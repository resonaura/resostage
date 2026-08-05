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

  if (auxBusses.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-1 border-t border-default/20 py-1">
      {auxBusses.map((bus) => {
        const existing = sends.find((s) => s.busId === bus.id);
        const value = existing?.gainDb ?? SEND_FLOOR_DB;
        return (
          <div
            key={bus.id}
            className="flex items-center justify-between gap-1 w-full px-0.5 min-w-0"
          >
            <span
              className="truncate text-[9px] font-mono font-medium min-w-0 flex-1 text-foreground/70"
              title={bus.name || bus.id}
            >
              {bus.name || bus.id}
            </span>
            <SendArcKnob
              value={value}
              min={SEND_FLOOR_DB}
              max={6}
              busColor="rgba(255,255,255,0.9)"
              title={`Send to ${bus.name || bus.id} (right-click to remove)`}
              onChange={(v) =>
                onSendChange
                  ? onSendChange(bus.id, v)
                  : mixer.setTrackSend(trackIndex, bus.id, v)
              }
              onContextMenu={
                onRemoveSend && existing
                  ? (e) => {
                      e.preventDefault();
                      // Stop propagation so the outer track-strip onContextMenu
                      // wrapper doesn't also fire (which would open the full
                      // track context menu and hide this "Remove Send" popup).
                      e.stopPropagation();
                      setRemoveMenu({
                        x: e.clientX,
                        y: e.clientY,
                        busId: bus.id,
                        busName: bus.name || bus.id,
                      });
                    }
                  : undefined
              }
            />
          </div>
        );
      })}
      {removeMenu && onRemoveSend && (
        <ContextMenu
          x={removeMenu.x}
          y={removeMenu.y}
          width={150}
          onClose={() => setRemoveMenu(null)}
        >
          <ContextMenuItem
            danger
            onClick={() => {
              onRemoveSend(removeMenu.busId);
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
