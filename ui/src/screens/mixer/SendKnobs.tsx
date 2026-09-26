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
  type SendTapMode,
} from "../../lib/types";

type SendMenu = {
  x: number;
  y: number;
  busId: string;
  busName: string;
  enabled: boolean;
  tap: SendTapMode;
  level: number;
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
  density = "standard",
  advancedSendRouting,
}: {
  auxBusses: BusRow[];
  sends: ClickSendRow[];
  trackIndex: number;
  /** Overrides the default per-track send write (used by the click strip).
   *  `level` is the schema's 0-100 percent, same as the wire. */
  onSendChange?: (busId: string, level: number, enabled?: boolean) => void;
  /** Enables the Enabled/Disabled toggle. Omit for surfaces without one. */
  onSendEnabledChange?: (busId: string, enabled: boolean) => void;
  density?: "narrow" | "standard" | "wide";
  advancedSendRouting?: boolean;
}) {
  const advanced = advancedSendRouting ??
    (typeof localStorage !== "undefined" &&
      localStorage.getItem("resostage:advanced-send-routing") === "true");
  const [menu, setMenu] = useState<SendMenu | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);

  const gesture = useRef(createEditGesture()).current;

  if (auxBusses.length === 0) return null;

  // Dynamic N+1 send rendering: only buses with active/assigned sends on this strip
  const activeAuxBusses = auxBusses.filter((bus) =>
    sends.some((s) => s.busId === bus.id),
  );
  const unassignedBusses = auxBusses.filter(
    (bus) => !sends.some((s) => s.busId === bus.id),
  );

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

  const writeTap = (busId: string, tap: SendTapMode, level: number) => {
    void mixer.setTrackSend(trackIndex, busId, level, undefined, gesture.id(), tap);
  };

  const removeSend = (busId: string) => {
    if (trackIndex >= 0) {
      void mixer.removeTrackSend(trackIndex, busId);
    } else if (onSendChange) {
      onSendChange(busId, 0, false);
    }
  };

  const isNarrow = density === "narrow";

  return (
    <div className="flex w-full flex-col gap-1 border-t border-default/20 py-1">
      {activeAuxBusses.map((bus) => {
        const existing = sends.find((s) => s.busId === bus.id);
        const value =
          existing !== undefined
            ? sendLevelToDb(existing.level)
            : SEND_FLOOR_DB;
        const enabled = existing ? existing.enabled !== false : true;
        const tap: SendTapMode = existing?.tap ?? (existing?.preFader ? "pre-fader" : "post-pan");
        const label = bus.name || bus.id;

        const ringColor = advanced
          ? (tap === "pre-fader"
            ? "var(--rs-send-pre, #0a84ff)"
            : tap === "post-fader"
              ? "var(--rs-send-post, #5e5ce6)"
              : "var(--rs-send-pan, #30d158)")
          : "var(--rs-send-post, #5e5ce6)";

        return (
          <div
            key={bus.id}
            className={`flex items-center justify-between gap-1 w-full px-0.5 min-w-0 transition-opacity duration-300 ${
              enabled ? "opacity-100" : "opacity-35"
            }`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                busId: bus.id,
                busName: label,
                enabled,
                tap,
                level: existing?.level ?? 100,
              });
            }}
          >
            <span
              className="truncate text-[9px] font-mono font-medium min-w-0 flex-1 text-foreground/75 select-none"
              title={advanced ? `${label} (${tap.toUpperCase()}) — right-click for options` : `${label} — right-click for options`}
            >
              {label}
            </span>
            <SendArcKnob
              value={value}
              min={SEND_FLOOR_DB}
              max={SEND_CEILING_DB}
              busColor={ringColor}
              title={
                enabled
                  ? (advanced ? `Send to ${label} (${tap.toUpperCase()}) — right-click for options` : `Send to ${label}`)
                  : `Send to ${label} — disabled`
              }
              onChange={(v) => writeLevel(bus.id, sendDbToLevel(v))}
            />
          </div>
        );
      })}

      {/* Dynamic N+1: "+ Add Send" button when unassigned aux buses are available */}
      {unassignedBusses.length > 0 && (
        <button
          type="button"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setAddMenu({ x: rect.left, y: rect.bottom + 2 });
          }}
          className="flex h-5 w-full items-center justify-center rounded border border-dashed border-default/25 text-[8.5px] font-mono text-foreground/35 hover:border-default/45 hover:bg-default/10 hover:text-foreground/75 transition-colors"
          title="Add Aux Send"
          aria-label="Add Aux Send"
        >
          {isNarrow ? "+" : activeAuxBusses.length === 0 ? "+ Add Send" : "+ Send"}
        </button>
      )}

      {addMenu && (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          width={180}
          onClose={() => setAddMenu(null)}
        >
          <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-foreground/40 border-b border-default/20">
            Route Send To Bus
          </div>
          {unassignedBusses.map((bus) => (
            <ContextMenuItem
              key={bus.id}
              onClick={() => {
                writeLevel(bus.id, 100, true);
                setAddMenu(null);
              }}
            >
              {bus.name || bus.id}
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          width={190}
          onClose={() => setMenu(null)}
        >
          {advanced && (
            <>
              <ContextMenuItem
                onClick={() => {
                  writeTap(menu.busId, "post-pan", menu.level);
                  setMenu(null);
                }}
              >
                {menu.tap === "post-pan" ? "✓ Post-Pan (Standard)" : "Post-Pan (Standard)"}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  writeTap(menu.busId, "post-fader", menu.level);
                  setMenu(null);
                }}
              >
                {menu.tap === "post-fader" ? "✓ Post-Fader (Pre-Pan)" : "Post-Fader (Pre-Pan)"}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  writeTap(menu.busId, "pre-fader", menu.level);
                  setMenu(null);
                }}
              >
                {menu.tap === "pre-fader" ? "✓ Pre-Fader (Monitor)" : "Pre-Fader (Monitor)"}
              </ContextMenuItem>
              <div className="my-1 border-t border-default/20" />
            </>
          )}
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
          <div className="my-1 border-t border-default/20" />
          <ContextMenuItem
            danger
            onClick={() => {
              removeSend(menu.busId);
              setMenu(null);
            }}
          >
            Remove Send
          </ContextMenuItem>
        </ContextMenu>
      )}
    </div>
  );
}
