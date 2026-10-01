/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useRef, useState } from "react";
import { WandSparkles } from "lucide-react";
import { Button } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "@/components/common/ContextMenu";
import type { PianoRollToolbarProps } from "@/screens/editor/pianoroll/toolbar/logic/types";

type PianoRollTransformsProps = Pick<PianoRollToolbarProps,
  "onQuantize" | "onHumanize" | "onLegato" | "onOverlapTrim" | "onTranspose"
> & { snapEnabled?: boolean };

/** Infrequent note transformations share the app's native/browser menu policy. */
export function PianoRollTransforms({
  onQuantize,
  onHumanize,
  onLegato,
  onOverlapTrim,
  onTranspose,
  snapEnabled: _snapEnabled,
}: PianoRollTransformsProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <Button
        ref={buttonRef}
        size="sm"
        variant="tertiary"
        isIconOnly
        aria-label="Note transformations"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onPress={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <WandSparkles size={13} />
      </Button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} width={224} onClose={() => setMenu(null)}>
          <ContextMenuItem
            shortcutCommand="piano-roll.quantize"
            onClick={onQuantize}
          >
            Quantize to Grid
          </ContextMenuItem>
          <ContextMenuItem onClick={onHumanize}>Humanize</ContextMenuItem>
          {onLegato && <ContextMenuItem onClick={onLegato}>Make Legato</ContextMenuItem>}
          {onOverlapTrim && (
            <ContextMenuItem onClick={onOverlapTrim}>Trim Overlaps</ContextMenuItem>
          )}
          <ContextMenuDivider />
          <ContextMenuItem shortcutCommand="piano-roll.transpose-up" onClick={() => onTranspose(1)}>
            Transpose Up a Semitone
          </ContextMenuItem>
          <ContextMenuItem shortcutCommand="piano-roll.transpose-down" onClick={() => onTranspose(-1)}>
            Transpose Down a Semitone
          </ContextMenuItem>
          <ContextMenuItem shortcutCommand="piano-roll.transpose-octave-up" onClick={() => onTranspose(12)}>
            Transpose Up an Octave
          </ContextMenuItem>
          <ContextMenuItem shortcutCommand="piano-roll.transpose-octave-down" onClick={() => onTranspose(-12)}>
            Transpose Down an Octave
          </ContextMenuItem>
        </ContextMenu>
      )}
    </>
  );
}
