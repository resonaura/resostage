/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
  ContextMenuSubmenu,
} from "@/components/common/ContextMenu";
import { pluginChains, type PluginCatalogEntry } from "@/lib/state/api";
import type { PluginSlotRow } from "@/lib/state/types";
import { groupEffects, type PluginGroup } from "@/screens/mixer/plugins/logic/pluginGroups";
import { PluginSlotControl } from "@/screens/mixer/plugins/PluginSlotControl";

interface SlotMenu {
  x: number;
  y: number;
  slot: PluginSlotRow | null;
  index: number;
}

function effectCategoryMenus(
  groups: PluginGroup[],
  disabled: boolean,
  onChoose: (plugin: PluginCatalogEntry) => void,
): React.ReactNode {
  if (groups.length === 0) {
    return (
      <ContextMenuItem disabled onClick={() => {}}>
        No effects · scan in Settings
      </ContextMenuItem>
    );
  }

  return groups.map((group) => (
    <ContextMenuSubmenu key={group.name} label={group.name} disabled={disabled}>
      {group.plugins.map((plugin) => (
        <ContextMenuItem key={plugin.id} onClick={() => onChoose(plugin)}>
          {plugin.name}
          {plugin.manufacturer ? ` · ${plugin.manufacturer}` : ""}
        </ContextMenuItem>
      ))}
    </ContextMenuSubmenu>
  ));
}

/**
 * Compact console insert rack. Existing processors occupy named rows; the
 * first vacant row is a real add target. Click a filled row to manage the
 * whole chain, or open its context menu for one-slot operations.
 */
export function PluginInsertSlots({
  stripId,
  stripName,
  slots,
  slotIndexOffset = 0,
  catalog,
  onOpenChain,
  targetSlotCount,
}: {
  stripId: string;
  stripName: string;
  slots: PluginSlotRow[];
  slotIndexOffset?: number;
  catalog: PluginCatalogEntry[];
  onOpenChain: () => void;
  density?: "narrow" | "standard" | "wide";
  targetSlotCount?: number;
}) {
  const [menu, setMenu] = useState<SlotMenu | null>(null);
  const [draggedSlotId, setDraggedSlotId] = useState<string | null>(null);
  const groups = useMemo(() => groupEffects(catalog), [catalog]);
  // Smart aligned mixer racks: match targetSlotCount across strips
  const rowCount = Math.min(
    32,
    Math.max(targetSlotCount ?? 1, slots.length + 1),
  );

  const openMenu = (
    event: React.MouseEvent<HTMLElement>,
    slot: PluginSlotRow | null,
    index: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, slot, index });
  };

  const openEmptySlot = (
    event: React.MouseEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left + 6, y: rect.bottom + 2, slot: null, index });
  };

  const addPlugin = (plugin: PluginCatalogEntry) => {
    void pluginChains.add(stripId, plugin.id);
    setMenu(null);
  };

  return (
    <>
      <div className="my-1 flex w-full flex-col">
        <div className="mb-0.5 flex w-full items-center justify-between px-0.5">
          <span className="font-mono text-[8px] uppercase tracking-wider text-foreground/40">
            FX
          </span>
          <button
            type="button"
            onClick={onOpenChain}
            title={`Manage Audio FX for ${stripName}`}
            aria-label={`Manage Audio FX for ${stripName}`}
            className="rounded p-0.5 text-foreground/40 hover:bg-default/20 hover:text-foreground transition-colors"
          >
            <SlidersHorizontal size={10} />
          </button>
        </div>

        <div
          className={`max-h-24 w-full ${
            slots.length > 3 ? "overflow-y-auto" : "overflow-hidden"
          }`}
          aria-label={`Audio FX for ${stripName}`}
        >
          {Array.from({ length: rowCount }, (_, index) => {
            const slot = slots[index] ?? null;
            if (!slot) {
              return (
                <button
                  key={`empty-${index}`}
                  type="button"
                  title={`Empty FX ${index + 1} · add effect`}
                  aria-label={`Empty FX slot ${index + 1}`}
                  onClick={(event) => openEmptySlot(event, index)}
                  onContextMenu={(event) => openMenu(event, null, index)}
                  className="mb-0.5 flex h-5.5 w-full items-center justify-center rounded border border-default/20 bg-surface/35 px-1 text-[11px] leading-none text-foreground/45 transition-colors last:mb-0 hover:border-default/45 hover:bg-default/10"
                >
                  <span aria-hidden="true">+</span>
                </button>
              );
            }
            return (
              <div
                key={slot?.id ?? `empty-${index}`}
                draggable
                onDragStart={(event) => {
                  setDraggedSlotId(slot.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", slot.id);
                }}
                onDragOver={(event) => {
                  if (draggedSlotId && draggedSlotId !== slot.id) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const source = draggedSlotId;
                  setDraggedSlotId(null);
                  if (source && source !== slot.id)
                    void pluginChains.move(stripId, source, index + slotIndexOffset);
                }}
                onDragEnd={() => setDraggedSlotId(null)}
                className={`mb-0.5 w-full last:mb-0 ${draggedSlotId && draggedSlotId !== slot.id ? "border-t border-accent" : ""}`}
              >
                <PluginSlotControl
                  name={slot.name || "Unknown plug-in"}
                  bypassed={slot.bypassed}
                  loadState={slot.loadState}
                  loadError={slot.loadError}
                  onOpen={() => void pluginChains.openEditor(stripId, slot.id)}
                  onToggle={() =>
                    void pluginChains.setBypassed(stripId, slot.id, !slot.bypassed)
                  }
                  onSwap={(event) => openMenu(event, slot, index)}
                  onDelete={(event) => {
                    event.stopPropagation();
                    void pluginChains.remove(stripId, slot.id);
                  }}
                  onContextMenu={(event) => openMenu(event, slot, index)}
                  title={`${slot.name} · click to open editor, right-click for options`}
                />
              </div>
            );
          })}
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          width={236}
          onClose={() => setMenu(null)}
        >
          {menu.slot ? (
            <>
              <ContextMenuItem
                onClick={() => {
                  void pluginChains.openEditor(stripId, menu.slot!.id);
                  setMenu(null);
                }}
              >
                Open Editor Window
              </ContextMenuItem>
              <ContextMenuDivider />
              <ContextMenuSubmenu label="Swap Plug-in">
                {effectCategoryMenus(groups, false, (plugin) => {
                  void pluginChains.replace(stripId, menu.slot!.id, plugin.id);
                  setMenu(null);
                })}
              </ContextMenuSubmenu>
              <ContextMenuItem
                onClick={() => {
                  void pluginChains.setBypassed(
                    stripId,
                    menu.slot!.id,
                    !menu.slot!.bypassed,
                  );
                  setMenu(null);
                }}
              >
                {menu.slot.bypassed ? "Enable" : "Bypass"}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={menu.index === 0}
                onClick={() => {
                  void pluginChains.move(
                    stripId,
                    menu.slot!.id,
                    menu.index - 1 + slotIndexOffset,
                    -1,
                  );
                  setMenu(null);
                }}
              >
                Move Up
              </ContextMenuItem>
              <ContextMenuItem
                disabled={menu.index >= slots.length - 1}
                onClick={() => {
                  void pluginChains.move(
                    stripId,
                    menu.slot!.id,
                    menu.index + 1 + slotIndexOffset,
                    1,
                  );
                  setMenu(null);
                }}
              >
                Move Down
              </ContextMenuItem>
              <ContextMenuItem
                danger
                onClick={() => {
                  void pluginChains.remove(stripId, menu.slot!.id);
                  setMenu(null);
                }}
              >
                Remove {menu.slot.name}
              </ContextMenuItem>
              <ContextMenuDivider />
              <ContextMenuItem
                onClick={() => {
                  setMenu(null);
                  onOpenChain();
                }}
              >
                Manage Audio FX Chain…
              </ContextMenuItem>
              <ContextMenuSubmenu
                label="Add Effect"
                disabled={slots.length >= 32}
              >
                {effectCategoryMenus(groups, slots.length >= 32, addPlugin)}
              </ContextMenuSubmenu>
            </>
          ) : (
            effectCategoryMenus(groups, slots.length >= 32, addPlugin)
          )}
        </ContextMenu>
      )}
    </>
  );
}
