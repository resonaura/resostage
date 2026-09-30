import { Checkbox } from "@/components/ui";
import type { PluginCatalogEntry } from "@/lib/state/api";
import { displayFormat } from "@/lib/plugins/pluginCategories";
import type { PluginFamily } from "@/screens/settings/plugins/logic/pluginFamilies";

export function PluginFamilyRow({
  family,
  onPluginEnabledChange,
}: {
  family: PluginFamily;
  onPluginEnabledChange: (
    plugin: PluginCatalogEntry,
    enabled: boolean,
  ) => void;
}) {
  const isNew = family.variants.some((plugin) => plugin.isNew);

  return (
    <div
      className={`grid gap-2 border-b px-4 py-2.5 last:border-b-0 lg:grid-cols-[minmax(12rem,1fr)_minmax(20rem,1.35fr)] ${
        isNew ? "border-warning/25 bg-warning/8" : "border-default/20"
      }`}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{family.name}</span>
          {isNew && (
            <span className="shrink-0 text-[10px] font-bold uppercase text-warning">
              New
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-foreground/45">
          {family.manufacturer || "Unknown vendor"}
          {family.category ? ` · ${family.category}` : ""}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        {family.variants.map((plugin) => (
          <Checkbox
            key={plugin.id}
            isSelected={plugin.enabled !== false}
            onChange={(enabled) =>
              void onPluginEnabledChange(plugin, enabled)
            }
            aria-label={`${plugin.enabled === false ? "Enable" : "Disable"} ${plugin.name} ${displayFormat(plugin.format)}`}
          >
            <Checkbox.Content className="gap-1.5">
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <span className="rounded-md bg-default/20 px-1.5 py-0.5 text-[10px] font-semibold">
                {displayFormat(plugin.format)}
              </span>
              <span className="whitespace-nowrap font-mono text-[10px] text-foreground/45">
                {plugin.instrument
                  ? "instrument"
                  : `${plugin.inputs ?? 2}→${plugin.outputs ?? 2}`}
              </span>
            </Checkbox.Content>
          </Checkbox>
        ))}
        {family.variants.some(
          (plugin) => (plugin.inputs ?? 2) > 2 || (plugin.outputs ?? 2) > 2,
        ) && (
          <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            Multi-I/O · main stereo pair hosted
          </span>
        )}
        {family.variants.some((plugin) => plugin.instrument) && (
          <span className="rounded-md bg-secondary/15 px-1.5 py-0.5 text-[10px] font-semibold text-secondary">
            Instrument
          </span>
        )}
      </div>
    </div>
  );
}
