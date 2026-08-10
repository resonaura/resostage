import { useState } from "react";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "../../components/ContextMenu";
import { InlineNamePrompt } from "../../components/InlineNamePrompt";
import { builder, mixer } from "../../lib/api";
import {
  sourceOutputBusId,
  type BusRow,
  type TrackRow,
} from "../../lib/types";

/** Kind of mixer strip — drives which menu items are visible. */
export type StripMenuKind = "track" | "master" | "send" | "click";

export type StripMenuTarget =
  | {
      kind: "track";
      x: number;
      y: number;
      index: number;
      track: TrackRow;
      songIndex: number;
    }
  | {
      kind: "master" | "send";
      x: number;
      y: number;
      index: number;
      bus: BusRow;
    }
  | {
      kind: "click";
      x: number;
      y: number;
      name: string;
      onRename: (name: string) => void;
      onResetGainPan: () => void;
      onClearMuteSolo: () => void;
      hasSends: boolean;
      onRemoveAllSends: () => void;
    };

/**
 * One context menu for every mixer strip. Items are shown/hidden by kind:
 * - track: rename, move, reset, clear M/S, remove sends, remove
 * - master: rename, reset, clear M/S (no remove, no move, no sends)
 * - send (aux): rename, reset, clear M/S, remove (no move, no sends-to-sends)
 * - click: rename, reset, clear M/S, remove all click sends (no remove strip)
 */
export function StripContextMenu({
  target,
  onClose,
}: {
  target: StripMenuTarget;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(
    target.kind === "track"
      ? target.track.name || target.track.id
      : target.kind === "click"
        ? target.name
        : target.bus.name || target.bus.id,
  );

  const act = (fn: () => void) => {
    fn();
    onClose();
  };

  const canMove = target.kind === "track";
  const canRemoveSends = target.kind === "track" || target.kind === "click";
  const canRemoveStrip = target.kind === "track" || target.kind === "send";
  // Master + click strips are permanent.
  const showRemove = canRemoveStrip;

  const commitRename = () => {
    const name = nameDraft.trim();
    if (name.length === 0) {
      onClose();
      return;
    }
    if (target.kind === "track") {
      void builder.trackUpdate({
        songIndex: target.songIndex,
        index: target.index,
        name,
        busId: sourceOutputBusId(target.track.output),
        gainDb: target.track.gainDb,
        pan: target.track.pan,
        mute: target.track.mute,
        solo: target.track.solo,
      });
    } else if (target.kind === "click") {
      target.onRename(name);
    } else {
      void builder.busUpdate({
        index: target.index,
        name,
        channels: target.bus.channels,
        startChannel: target.bus.startChannel,
        gainDb: target.bus.gainDb,
        pan: target.bus.pan,
        mute: target.bus.mute,
        solo: target.bus.solo,
        isAux: target.bus.isAux,
      });
    }
    onClose();
  };

  const hasSends =
    target.kind === "track"
      ? target.track.output.sends.length > 0
      : target.kind === "click"
        ? target.hasSends
        : false;

  // The name field is a sibling of the menu, not an item in it -- see
  // InlineNamePrompt for why nesting it never worked under Electron.
  if (renaming) {
    return (
      <InlineNamePrompt
        x={target.x}
        y={target.y}
        value={nameDraft}
        placeholder="Strip name"
        onChange={setNameDraft}
        onCommit={commitRename}
        onCancel={onClose}
      />
    );
  }

  return (
    <ContextMenu x={target.x} y={target.y} onClose={onClose}>
      <ContextMenuItem onClick={() => setRenaming(true)}>
        Rename...
      </ContextMenuItem>

      {canMove && target.kind === "track" && (
        <>
          <ContextMenuItem
            onClick={() =>
              act(
                () =>
                  void builder.trackMove(target.songIndex, target.index, -1),
              )
            }
          >
            Move Left
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() =>
              act(
                () => void builder.trackMove(target.songIndex, target.index, 1),
              )
            }
          >
            Move Right
          </ContextMenuItem>
        </>
      )}

      <ContextMenuDivider />

      <ContextMenuItem
        onClick={() =>
          act(() => {
            if (target.kind === "track") {
              void mixer.setTrackGain(target.index, 0);
              void mixer.setTrackPan(target.index, 0);
            } else if (target.kind === "click") {
              target.onResetGainPan();
            } else {
              void mixer.setBusGain(target.index, 0);
              void mixer.setBusPan(target.index, 0);
            }
          })
        }
      >
        Reset Gain & Pan
      </ContextMenuItem>

      <ContextMenuItem
        onClick={() =>
          act(() => {
            if (target.kind === "track") {
              void mixer.setTrackMute(target.index, false);
              void mixer.setTrackSolo(target.index, false);
            } else if (target.kind === "click") {
              target.onClearMuteSolo();
            } else {
              void mixer.setBusMute(target.index, false);
              void mixer.setBusSolo(target.index, false);
            }
          })
        }
      >
        Clear Mute & Solo
      </ContextMenuItem>

      {canRemoveSends && (
        <ContextMenuItem
          disabled={!hasSends}
          onClick={() =>
            act(() => {
              if (target.kind === "track") {
                for (const s of target.track.output.sends)
                  void mixer.removeTrackSend(target.index, s.bus);
              } else if (target.kind === "click") {
                target.onRemoveAllSends();
              }
            })
          }
        >
          Remove All Sends
        </ContextMenuItem>
      )}

      {showRemove && (
        <>
          <ContextMenuDivider />
          <ContextMenuItem
            danger
            onClick={() =>
              act(() => {
                if (target.kind === "track") {
                  void builder.trackRemove(target.songIndex, target.index);
                } else if (target.kind === "send") {
                  void builder.busRemove(target.index);
                }
              })
            }
          >
            {target.kind === "send" ? "Remove Send" : "Remove Track"}
          </ContextMenuItem>
        </>
      )}
    </ContextMenu>
  );
}
