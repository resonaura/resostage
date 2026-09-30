import type { PluginCatalogEntry } from "@/lib/state/api";
import {
  deduplicatePlugins,
  displayCategory,
} from "@/lib/plugins/pluginCategories";

export interface PluginGroup {
  name: string;
  plugins: PluginCatalogEntry[];
}

export function groupInstruments(
  plugins: PluginCatalogEntry[],
): PluginGroup[] {
  const groups = new Map<string, PluginCatalogEntry[]>();
  const instruments = plugins.filter(
    (p) => p.instrument && p.enabled !== false,
  );
  const deduplicated = deduplicatePlugins(instruments);

  for (const plugin of deduplicated) {
    const rawMfg = (plugin.manufacturer || "").trim();
    const groupName = rawMfg || plugin.category || "Instruments";
    const group = groups.get(groupName) ?? [];
    group.push(plugin);
    groups.set(groupName, group);
  }

  return [...groups]
    .map(([name, entries]) => ({
      name,
      plugins: entries.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

export function groupEffects(plugins: PluginCatalogEntry[]): PluginGroup[] {
  const groups = new Map<string, PluginCatalogEntry[]>();
  const deduplicated = deduplicatePlugins(plugins);
  for (const plugin of deduplicated) {
    // An audio insert must accept audio. Keep generators/instruments in the
    // device catalog, but do not offer them in an effect-chain menu where the
    // processor contract cannot be satisfied.
    if (plugin.instrument || (plugin.inputs ?? 2) <= 0) continue;
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
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}
