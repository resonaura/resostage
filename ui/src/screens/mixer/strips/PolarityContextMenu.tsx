/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import {
  ContextMenu,
  ContextMenuItem,
} from "@/components/common/ContextMenu";
import {
  getTrackPolarityOptions,
  type TrackPolarity,
} from "@/screens/mixer/logic/polarity";

export function PolarityContextMenu({
  position,
  isMono,
  polarity,
  onSelect,
  onClose,
}: {
  position: { x: number; y: number } | null;
  isMono: boolean;
  polarity: TrackPolarity;
  onSelect: (polarity: TrackPolarity) => void;
  onClose: () => void;
}) {
  if (!position) return null;

  return (
    <ContextMenu
      x={position.x}
      y={position.y}
      width={180}
      onClose={onClose}
    >
      {getTrackPolarityOptions(isMono).map(({ value, label }) => (
        <ContextMenuItem
          key={value}
          onClick={() => {
            onSelect(value);
            onClose();
          }}
        >
          {polarity === value ? `✓ ${label}` : label}
        </ContextMenuItem>
      ))}
    </ContextMenu>
  );
}
