/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useState } from "react";
import { Locate, LocateFixed, LocateOff } from "lucide-react";
import { ToggleButton } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "@/components/common/ContextMenu";
import type { TimelineFollowMode } from "@/screens/editor/timeline/toolbar/logic/types";

interface PianoRollFollowControlProps {
  followMode?: TimelineFollowMode;
  onCycleFollowMode?: () => void;
  catchOnPlay?: boolean;
  onCatchOnPlayChange?: (value: boolean) => void;
  catchOnSeek?: boolean;
  onCatchOnSeekChange?: (value: boolean) => void;
}

export function PianoRollFollowControl({
  followMode,
  onCycleFollowMode,
  catchOnPlay,
  onCatchOnPlayChange,
  catchOnSeek,
  onCatchOnSeekChange,
}: PianoRollFollowControlProps) {
  const [followMenu, setFollowMenu] = useState<{ x: number; y: number } | null>(
    null,
  );

  return (
    <>
      {/* Playhead Autofollow Button */}
      {followMode && onCycleFollowMode && (
        <div className="flex shrink-0 items-center">
          <ToggleButton
            size="sm"
            isIconOnly
            isSelected={followMode !== "off"}
            aria-label={
              followMode === "off"
                ? "Playhead autofollow: off (click cycles mode, right-click options)"
                : followMode === "snap"
                  ? "Playhead autofollow: standard (click cycles, right-click options)"
                  : "Playhead autofollow: smooth (click cycles, right-click options)"
            }
            onPress={onCycleFollowMode}
            onContextMenu={(e) => {
              e.preventDefault();
              setFollowMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            {followMode === "off" ? (
              <LocateOff size={13} />
            ) : followMode === "snap" ? (
              <Locate size={13} />
            ) : (
              <LocateFixed size={13} />
            )}
          </ToggleButton>
        </div>
      )}

      {followMenu && onCatchOnPlayChange && onCatchOnSeekChange && (
        <ContextMenu
          x={followMenu.x}
          y={followMenu.y}
          width={240}
          onClose={() => setFollowMenu(null)}
        >
          <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-foreground/40">
            Follow playhead
          </div>
          <ContextMenuItem
            checked={catchOnPlay ?? true}
            onClick={() => {
              onCatchOnPlayChange(!(catchOnPlay ?? true));
            }}
          >
            Catch when Starting Playback
          </ContextMenuItem>
          <ContextMenuItem
            checked={catchOnSeek ?? true}
            onClick={() => {
              onCatchOnSeekChange(!(catchOnSeek ?? true));
            }}
          >
            Catch when Moving Playhead
          </ContextMenuItem>
          <ContextMenuDivider />
          <div className="px-2.5 py-1.5 text-[10px] leading-snug text-foreground/40">
            Manual scroll while playing suspends follow. Play / scrub can
            re-enable it based on the options above.
          </div>
        </ContextMenu>
      )}
    </>
  );
}
