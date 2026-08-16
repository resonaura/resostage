import { useRef, useState } from "react";
import { ContextMenu, ContextMenuItem } from "../../components/ContextMenu";
import {
  SEND_CEILING_DB,
  SEND_FLOOR_DB,
  SendArcKnob,
} from "../../components/daw";
import { mixer } from "../../lib/api";
import { createEditGesture } from "../../lib/editGesture";
import {
  sendDbToLevel,
  sendLevelToDb,
  type BusRow,
  type ClickSendRow,
} from "../../lib/types";

type SendMenu = {
  x: number;
  y: number;
  busId: string;
  busName: string;
  enabled: boolean;
};

/**
 * The aux-send column on a channel strip: one arc knob per send bus.
 *
 * A send has two independent states -- how much (level) and whether it is
 * live at all (enabled). Disabling is not "turn it to zero": it parks the
 * amount you dialled in so you can bring the send back exactly where it was,
 * which is the whole point during a soundcheck. Disabled sends fade out
 * rather than disappear, so the column never reflows under the cursor.
 */
export function SendKnobs({
  auxBusses,
  sends,
  trackIndex,
  onSendChange,
  onSendEnabledChange,
}: {
  auxBusses: BusRow[];
  sends: ClickSendRow[];
  trackIndex: number;
  /** Overrides the default per-track send write (used by the click strip).
   *  `level` is the schema's 0-100 percent, same as the wire. */
  onSendChange?: (busId: string, level: number, enabled?: boolean) => void;
  /** Enables the Enabled/Disabled toggle. Omit for surfaces without one. */
  onSendEnabledChange?: (busId: string, enabled: boolean) => void;
}) {
  const [menu, setMenu] = useState<SendMenu | null>(null);

  const gesture = useRef(createEditGesture()).current;

  if (auxBusses.length === 0) return null;

  // Percent is the unit of record everywhere below: the knob is the only
  // thing that thinks in dB, and it converts on the way out.
  const writeLevel = (busId: string, level: number, enabled?: boolean) => {
    if (onSendChange) {
      onSendChange(busId, level, enabled);
      return;
    }
    // A knob streams a value per frame; without a gesture id each one is its
    // own undo entry. See lib/editGesture.
    void mixer.setTrackSend(trackIndex, busId, level, enabled, gesture.id());
  };

  return (
    <div className="flex w-full flex-col gap-1 border-t border-default/20 py-1">
      {auxBusses.map((bus) => {
        const existing = sends.find((s) => s.busId === bus.id);
        const value =
          existing !== undefined
            ? sendLevelToDb(existing.level)
            : SEND_FLOOR_DB;
        // A send that was never created reads as enabled: the knob is at the
        // floor, so there is nothing to grey out yet.
        const enabled = existing ? existing.enabled !== false : true;
        const label = bus.name || bus.id;

        return (
          <div
            key={bus.id}
            className={`flex items-center justify-between gap-1 w-full px-0.5 min-w-0 transition-opacity duration-300 ${
              enabled ? "opacity-100" : "opacity-35"
            }`}
            onContextMenu={(e) => {
              // Always stop propagation so right-clicking a send row doesn't
              // also open the track strip's own menu on top of this one.
              e.preventDefault();
              e.stopPropagation();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                busId: bus.id,
                busName: label,
                enabled,
              });
            }}
          >
            <span
              className="truncate text-[9px] font-mono font-medium min-w-0 flex-1 text-foreground/70 select-none"
              title={label}
            >
              {label}
            </span>
            <SendArcKnob
              value={value}
              min={SEND_FLOOR_DB}
              max={SEND_CEILING_DB}
              busColor="var(--foreground)"
              title={
                enabled
                  ? `Send to ${label} (right-click for options)`
                  : `Send to ${label} — disabled`
              }
              onChange={(v) => writeLevel(bus.id, sendDbToLevel(v))}
            />
          </div>
        );
      })}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          width={190}
          onClose={() => setMenu(null)}
        >
          <ContextMenuItem
            onClick={() => {
              writeLevel(menu.busId, 0);
              setMenu(null);
            }}
          >
            Set to 0%
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              writeLevel(menu.busId, 100);
              setMenu(null);
            }}
          >
            Set to 100%
          </ContextMenuItem>
          {onSendEnabledChange && (
            <ContextMenuItem
              onClick={() => {
                onSendEnabledChange(menu.busId, !menu.enabled);
                setMenu(null);
              }}
            >
              {menu.enabled ? "Disable send" : "Enable send"}
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
