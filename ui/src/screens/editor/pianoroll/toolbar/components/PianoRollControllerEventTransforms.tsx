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

/** Curve/value transforms for the currently selected raw MIDI controller events. */
export function PianoRollControllerEventTransforms({
  onSetCurve,
  onSmooth,
}: {
  onSetCurve: (curve: number) => void;
  onSmooth: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const run = (action: () => void) => {
    action();
    setMenu(null);
  };

  return (
    <>
      <Button
        ref={buttonRef}
        size="sm"
        variant="tertiary"
        isIconOnly
        aria-label="Controller event curves and smoothing"
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
          <ContextMenuItem onClick={() => run(() => onSetCurve(0))}>
            Linear curve
          </ContextMenuItem>
          <ContextMenuItem onClick={() => run(() => onSetCurve(0.5))}>
            Curve up
          </ContextMenuItem>
          <ContextMenuItem onClick={() => run(() => onSetCurve(-0.5))}>
            Curve down
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem onClick={() => run(onSmooth)}>
            Smooth selected values
          </ContextMenuItem>
        </ContextMenu>
      )}
    </>
  );
}
