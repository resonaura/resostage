/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useMemo } from "react";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
  ContextMenuSubmenu,
} from "@/components/common/ContextMenu";
import {
  pluginChains,
  type PluginCatalogEntry,
} from "@/lib/state/api";
import type { PluginSlotRow } from "@/lib/state/types";
import { groupInstruments } from "@/screens/mixer/plugins/logic/pluginGroups";

export function InstrumentContextMenu({
  trackId,
  isInstrument,
  slot,
  name,
  catalog,
  position,
  onClose,
  onPresets,
}: {
  trackId: string;
  isInstrument: boolean;
  slot?: PluginSlotRow;
  name?: string;
  catalog: PluginCatalogEntry[];
  position: { x: number; y: number } | null;
  onClose: () => void;
  onPresets?: () => void;
}) {
  const instrumentGroups = useMemo(
    () => (isInstrument ? groupInstruments(catalog) : []),
    [isInstrument, catalog],
  );

  if (!position) return null;

  return (
    <ContextMenu
      x={position.x}
      y={position.y}
      width={220}
      onClose={onClose}
    >
      {slot && (
        <>
          <ContextMenuItem
            onClick={() => {
              void pluginChains.openEditor(trackId, slot.id);
              onClose();
            }}
          >
            Open {name}
          </ContextMenuItem>
          {onPresets && (
            <ContextMenuItem
              onClick={() => {
                onPresets();
                onClose();
              }}
            >
              Presets…
            </ContextMenuItem>
          )}
          {onPresets && <ContextMenuDivider />}
          {(slot.loadState === "failed" || slot.loadState === "missing") && (
            <ContextMenuItem
              onClick={() => {
                void pluginChains.retry(trackId, slot.id);
                onClose();
              }}
            >
              Retry loading
            </ContextMenuItem>
          )}
          <ContextMenuItem
            danger
            onClick={() => {
              void pluginChains.remove(trackId, slot.id);
              onClose();
            }}
          >
            No Plug-in
          </ContextMenuItem>
          <ContextMenuDivider />
        </>
      )}

      {instrumentGroups.length === 0 ? (
        <ContextMenuItem disabled onClick={() => {}}>
          No instruments scanned · see Settings
        </ContextMenuItem>
      ) : (
        instrumentGroups.map((group) => (
          <ContextMenuSubmenu key={group.name} label={group.name}>
            {group.plugins.map((plugin) => (
              <ContextMenuItem
                key={plugin.id}
                checked={slot?.pluginId === plugin.id}
                onClick={() => {
                  // Choosing the currently loaded catalog entry is a no-op,
                  // not a replacement command that needs an edit ACK.
                  if (slot) {
                    if (slot.pluginId !== plugin.id)
                      void pluginChains.replace(trackId, slot.id, plugin.id);
                  } else {
                    void pluginChains.add(trackId, plugin.id);
                  }
                  onClose();
                }}
              >
                {plugin.name}
                {plugin.format ? ` (${plugin.format})` : ""}
              </ContextMenuItem>
            ))}
          </ContextMenuSubmenu>
        ))
      )}
    </ContextMenu>
  );
}
