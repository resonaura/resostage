/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { ToggleButton, ToggleButtonGroup } from "@/components/ui";
import {
  SCOPE_FILTERS,
  type CategoryFilterDef,
  type ScopeFilterDef,
} from "@/lib/plugins/pluginCategories";

export function PluginCatalogFilters({
  scopeFilter,
  onScopeFilterChange,
  categoryFilter,
  onCategoryFilterChange,
  categoryCounts,
  availableCategories,
  newCount,
  quarantinedCount,
}: {
  scopeFilter: ScopeFilterDef["id"];
  onScopeFilterChange: (filter: ScopeFilterDef["id"]) => void;
  categoryFilter: string;
  onCategoryFilterChange: (category: string) => void;
  categoryCounts: ReadonlyMap<string, number>;
  availableCategories: readonly CategoryFilterDef[];
  newCount: number;
  quarantinedCount: number;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-foreground/45">
          Type
        </span>
        <ToggleButtonGroup
          size="xs"
          isDetached
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([scopeFilter])}
          onSelectionChange={(keys) => {
            const next = Array.from(keys)[0];
            if (next) onScopeFilterChange(String(next) as ScopeFilterDef["id"]);
          }}
          aria-label="Filter by plug-in type"
          className="flex flex-wrap gap-1.5"
        >
          {SCOPE_FILTERS.map(({ id, label, icon: Icon, tone }) => {
            const count =
              id === "new"
                ? newCount
                : id === "quarantined"
                  ? quarantinedCount
                  : undefined;
            return (
              <ToggleButton
                key={id}
                id={id}
                tone={tone}
                onPress={() => onScopeFilterChange(id)}
                className="gap-1.5 px-3 py-1 text-xs"
              >
                <Icon size={12} className="shrink-0" />
                <span>{label}</span>
                {count != null && count > 0 && (
                  <span className="ml-1 rounded-full bg-default/30 px-1 text-[9px] font-mono tabular-nums">
                    {count}
                  </span>
                )}
              </ToggleButton>
            );
          })}
        </ToggleButtonGroup>
      </div>

      {scopeFilter !== "quarantined" && (
        <div className="flex flex-wrap items-center gap-3 pt-0.5">
          <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-foreground/45">
            Category
          </span>
          <ToggleButtonGroup
            size="xs"
            isDetached
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([categoryFilter])}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (next) onCategoryFilterChange(String(next));
            }}
            aria-label="Filter by plug-in category"
            className="flex flex-wrap gap-1.5"
          >
            {availableCategories.map(({ id, label }) => {
              const count = id === "all" ? undefined : categoryCounts.get(id);
              return (
                <ToggleButton
                  key={id}
                  id={id}
                  tone="accent-soft"
                  onPress={() => onCategoryFilterChange(id)}
                  className="px-3 py-1 text-xs"
                >
                  <span>{label}</span>
                  {count != null && (
                    <span className="ml-1 text-[10px] font-mono opacity-50 tabular-nums">
                      {count}
                    </span>
                  )}
                </ToggleButton>
              );
            })}
          </ToggleButtonGroup>
        </div>
      )}
    </>
  );
}
