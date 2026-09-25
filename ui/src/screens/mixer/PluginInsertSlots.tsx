import { SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
  ContextMenuSubmenu,
} from "../../components/ContextMenu";
import {
  pluginChains,
  type PluginCatalogEntry,
} from "../../lib/api";
import type { PluginSlotRow } from "../../lib/types";

interface SlotMenu {
  x: number;
  y: number;
  slot: PluginSlotRow | null;
  index: number;
}

import { deduplicatePlugins, displayCategory } from "../../lib/pluginCategories";

interface PluginGroup {
  name: string;
  plugins: PluginCatalogEntry[];
}

function groupEffects(plugins: PluginCatalogEntry[]): PluginGroup[] {
  const groups = new Map<string, PluginCatalogEntry[]>();
  const deduplicated = deduplicatePlugins(plugins);
  for (const plugin of deduplicated) {
    // An audio insert must accept audio. Keep generators/instruments in the
    // device catalog, but do not offer them in an effect-chain menu where the
    // processor contract cannot be satisfied.
    if (plugin.instrument || plugin.inputs <= 0) continue;
    const category = displayCategory(plugin);
    const group = groups.get(category) ?? [];
    group.push(plugin);
    groups.set(category, group);
  }
  return [...groups]
    .map(([name, entries]) => ({
      name,
      plugins: entries.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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
  catalog,
  onOpenChain,
}: {
  stripId: string;
  stripName: string;
  slots: PluginSlotRow[];
  catalog: PluginCatalogEntry[];
  onOpenChain: () => void;
}) {
  const [menu, setMenu] = useState<SlotMenu | null>(null);
  const groups = useMemo(() => groupEffects(catalog), [catalog]);
  const rowCount = Math.max(4, Math.min(32, slots.length + 1));

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
          Inserts
        </span>
        <button
          type="button"
          onClick={onOpenChain}
          title={`Manage insert chain for ${stripName}`}
          aria-label={`Manage insert chain for ${stripName}`}
          className="rounded p-0.5 text-foreground/40 hover:bg-default/20 hover:text-foreground transition-colors"
        >
          <SlidersHorizontal size={10} />
        </button>
      </div>

      <div
        className={`max-h-[5.5rem] w-full rounded-md border border-default/30 bg-background/60 p-0.5 ${
          slots.length > 4 ? "overflow-y-auto" : "overflow-hidden"
        }`}
        aria-label={`Insert effects for ${stripName}`}
      >
        {Array.from({ length: rowCount }, (_, index) => {
          const slot = slots[index] ?? null;
          return (
            <button
              key={slot?.id ?? `empty-${index}`}
              type="button"
              title={
                slot
                  ? `${slot.name} · click to open editor, right-click for options`
                  : `Empty insert ${index + 1} · add effect`
              }
              aria-label={
                slot
                  ? `${slot.name}, insert ${index + 1}`
                  : `Empty insert ${index + 1}`
              }
              onClick={(event) => {
                if (slot) {
                  void pluginChains.openEditor(stripId, slot.id);
                } else {
                  openEmptySlot(event, index);
                }
              }}
              onContextMenu={(event) => openMenu(event, slot, index)}
              className={`group/slot relative mb-0.5 flex h-[1.15rem] w-full items-center rounded-[4px] border px-1 text-left text-[8px] leading-none transition-colors last:mb-0 ${
                slot
                  ? slot.bypassed
                    ? "border-default/20 bg-default/10 text-foreground/35"
                    : "border-accent/30 bg-accent/10 text-foreground/75 hover:bg-accent/15"
                  : "border-default/20 bg-surface/35 text-foreground/25 hover:border-default/45 hover:bg-default/10"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">
                {slot?.name ?? ""}
              </span>
              {slot ? (
                <span
                  role="button"
                  tabIndex={0}
                  title={`Remove ${slot.name}`}
                  aria-label={`Remove ${slot.name}`}
                  className="ml-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center rounded text-foreground/40 opacity-0 transition-opacity hover:bg-danger/20 hover:text-danger group-hover/slot:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    void pluginChains.remove(stripId, slot.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      void pluginChains.remove(stripId, slot.id);
                    }
                  }}
                >
                  <X size={9} strokeWidth={2.5} />
                </span>
              ) : (
                <span
                  aria-hidden
                  className="opacity-0 transition-opacity group-hover/slot:opacity-70"
                >
                  +
                </span>
              )}
            </button>
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
                  void pluginChains.move(stripId, menu.slot!.id, menu.index - 1);
                  setMenu(null);
                }}
              >
                Move Up
              </ContextMenuItem>
              <ContextMenuItem
                disabled={menu.index >= slots.length - 1}
                onClick={() => {
                  void pluginChains.move(stripId, menu.slot!.id, menu.index + 1);
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
                Manage Insert Chain…
              </ContextMenuItem>
              <ContextMenuSubmenu
                label="Add Effect"
                disabled={slots.length >= 32}
              >
                {effectCategoryMenus(
                  groups,
                  slots.length >= 32,
                  addPlugin,
                )}
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
