/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { PluginParameterList } from "@/lib/state/types";

/** UI-derived warning: persisted automation still identifies a plug-in by slot ID. */
export type AutomationPluginParameterList = PluginParameterList & {
  scopeAmbiguous?: boolean;
};

export type AutomationPluginParameterCatalog = Readonly<
  Record<string, AutomationPluginParameterList>
>;

/** Encode both routing identity fields without delimiter-collision assumptions. */
export function pluginParameterKey(stripId: string, slotId: string): string {
  return JSON.stringify([stripId, slotId]);
}

/**
 * Prefer exact strip/slot identity. The unscoped fallback exists for legacy
 * callers and older tests; scoped wire responses must never cross strips.
 */
export function getPluginParameterList(
  catalog: AutomationPluginParameterCatalog,
  stripId: string,
  slotId: string,
): AutomationPluginParameterList | undefined {
  const exact = catalog[pluginParameterKey(stripId, slotId)];
  if (exact) return exact.stripId && exact.stripId !== stripId ? undefined : exact;
  const legacy = catalog[slotId];
  return legacy?.stripId == null ? legacy : undefined;
}
