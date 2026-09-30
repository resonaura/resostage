import { Card, ScrollShadow } from "../../../../components/ui";
import type { PluginCatalogEntry, PluginCatalogResponse } from "../../../../lib/state/api";
import type { ScopeFilterDef } from "../../../../lib/plugins/pluginCategories";
import { PluginFamilyRow } from "./PluginFamilyRow";
import type { PluginFamily } from "../logic/pluginFamilies";

function PluginQuarantineRow({ path }: { path: string }) {
  return (
    <div
      className="border-b border-danger/20 bg-danger/8 px-4 py-2.5 last:border-b-0"
    >
      <div className="truncate text-xs font-semibold text-danger">
        Scan failed · quarantined
      </div>
      <div className="truncate font-mono text-[10px] text-foreground/50">
        {path}
      </div>
    </div>
  );
}

export function PluginCatalogResults({
  catalog,
  scopeFilter,
  resultCount,
  quarantined,
  visibleFamilies,
  totalFamilyCount,
  onPluginEnabledChange,
}: {
  catalog: PluginCatalogResponse | null;
  scopeFilter: ScopeFilterDef["id"];
  resultCount: number;
  quarantined: string[];
  visibleFamilies: PluginFamily[];
  totalFamilyCount: number;
  onPluginEnabledChange: (
    plugin: PluginCatalogEntry,
    enabled: boolean,
  ) => void;
}) {
  return (
    <>
      <Card.Content className="min-h-0 flex-1 p-0">
        <ScrollShadow className="h-full overflow-y-auto" orientation="vertical">
          {resultCount === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-foreground/45">
              {catalog === null
                ? "Loading catalog…"
                : catalog.catalog.plugins.length === 0
                  ? "Run a scan to discover installed plug-ins."
                  : "No plug-ins match this view."}
            </div>
          ) : scopeFilter === "quarantined" ? (
            quarantined.map((path) => <PluginQuarantineRow key={path} path={path} />)
          ) : (
            visibleFamilies.map((family) => (
              <PluginFamilyRow
                key={family.key}
                family={family}
                onPluginEnabledChange={onPluginEnabledChange}
              />
            ))
          )}
        </ScrollShadow>
      </Card.Content>
      <Card.Footer className="shrink-0 justify-between border-t border-default/20 px-4 py-2 text-[11px] text-foreground/45">
        <span>{resultCount} matching</span>
        {totalFamilyCount > visibleFamilies.length &&
          scopeFilter !== "quarantined" && (
            <span>
              Showing {visibleFamilies.length}; narrow the search for bounded
              rendering
            </span>
          )}
      </Card.Footer>
    </>
  );
}
