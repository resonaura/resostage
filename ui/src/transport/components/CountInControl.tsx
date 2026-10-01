/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Tooltip } from "@heroui/react";
import { ListOrdered } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { settings as settingsApi } from "@/lib/state/api";
import type { WebUiState } from "@/lib/state/types";
import { ToggleButton } from "@/components/ui";
import { CountInContextMenu } from "@/transport/components/CountInContextMenu";

/** Device-wide count-in toggle; its context menu selects the effective length. */
export function CountInControl({
  state,
  compact = false,
}: {
  state: WebUiState;
  compact?: boolean;
}) {
  const [override, setOverride] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const bars = override ?? state.settings.countInBars ?? 1;
  const preferredBars = state.settings.countInPreferredBars ?? 1;
  const preferredBarsRef = useRef(preferredBars);
  const enabled = bars > 0;

  useEffect(() => {
    preferredBarsRef.current = preferredBars;
  }, [preferredBars]);

  useEffect(() => {
    if (override !== null && state.settings.countInBars === override)
      setOverride(null);
  }, [override, state.settings.countInBars]);

  const changeBars = (nextBars: number) => {
    if (nextBars > 0) preferredBarsRef.current = nextBars;
    setOverride(nextBars);
    void settingsApi.setCountInBars(nextBars).catch(() => setOverride(null));
  };

  return (
    <>
      <Tooltip>
        <ToggleButton
          size="sm"
          isIconOnly={compact}
          isSelected={enabled}
          variant={enabled ? "default" : "ghost"}
          aria-label={`Count-In ${enabled ? `On, ${bars} ${bars === 1 ? "bar" : "bars"}` : "Off"}`}
          onPress={() => changeBars(enabled ? 0 : preferredBarsRef.current)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
          className={compact ? "h-7 w-7 min-w-7 p-0" : undefined}
        >
          <ListOrdered size={15} aria-hidden="true" />
          {!compact && <span>Count-In</span>}
        </ToggleButton>
        <Tooltip.Content>
          Count-In: {enabled ? `${bars} ${bars === 1 ? "bar" : "bars"}` : "Off"} · right-click to set length
        </Tooltip.Content>
      </Tooltip>
      {menu && (
        <CountInContextMenu
          {...menu}
          bars={bars}
          onChange={changeBars}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
