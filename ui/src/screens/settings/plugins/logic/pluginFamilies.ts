import type { PluginCatalogEntry } from "../../../../lib/state/api";
import { displayCategory } from "../../../../lib/plugins/pluginCategories";

export interface PluginFamily {
  key: string;
  name: string;
  manufacturer: string;
  category: string;
  variants: PluginCatalogEntry[];
}

function pluginFamilyKey(plugin: PluginCatalogEntry): string {
  const normalize = (value: string) =>
    value
      .toLocaleLowerCase()
      .replace(/\b(?:audio\s*unit|vst3?|au)\b/gi, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return `${normalize(plugin.manufacturer)}::${normalize(plugin.name)}`;
}

export function groupPluginFamilies(
  plugins: PluginCatalogEntry[],
): PluginFamily[] {
  const grouped = new Map<string, PluginFamily>();
  for (const plugin of plugins) {
    const key = pluginFamilyKey(plugin);
    const cat = displayCategory(plugin);
    const family = grouped.get(key) ?? {
      key,
      name: plugin.name,
      manufacturer: plugin.manufacturer,
      category: cat,
      variants: [],
    };
    if (
      !family.category ||
      family.category === "Other" ||
      family.category === "Effect" ||
      family.category === "Fx"
    ) {
      family.category = cat;
    }
    family.variants.push(plugin);
    grouped.set(key, family);
  }
  return [...grouped.values()]
    .map((family) => ({
      ...family,
      variants: family.variants.sort((a, b) =>
        a.format.localeCompare(b.format),
      ),
    }))
    .sort((a, b) =>
      `${a.manufacturer}\0${a.name}`.localeCompare(
        `${b.manufacturer}\0${b.name}`,
        undefined,
        { sensitivity: "base" },
      ),
    );
}
