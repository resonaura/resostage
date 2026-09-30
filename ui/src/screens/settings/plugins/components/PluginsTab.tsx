import { useEffect, useMemo, useState } from "react";
import { Card } from "../../../../components/ui";
import {
  pluginCatalog as pluginCatalogApi,
  type PluginCatalogEntry,
  type PluginCatalogResponse,
} from "../../../../lib/state/api";
import {
  GLOBAL_CATEGORIES,
  type ScopeFilterDef,
} from "../../../../lib/plugins/pluginCategories";
import { PluginCatalogFilters } from "./PluginCatalogFilters";
import { PluginCatalogResults } from "./PluginCatalogResults";
import { PluginScanControls } from "./PluginScanControls";
import { groupPluginFamilies } from "../logic/pluginFamilies";

// ─── Plug-ins Tab ─────────────────────────────────────────────────────────
// The catalog is intentionally fetched on demand instead of joining the 60 Hz
// live-state payload. It can contain hundreds of rows and only changes after a
// scan, so broadcasting it would waste CPU and network bandwidth.
export function PluginsTab() {
  const [catalog, setCatalog] = useState<PluginCatalogResponse | null>(null);
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilterDef["id"]>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [requestError, setRequestError] = useState("");

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await pluginCatalogApi.list();
        if (disposed) return;
        setCatalog(next);
        setRequestError("");
      } catch (error) {
        if (!disposed)
          setRequestError(
            error instanceof Error ? error.message : "Could not load plug-ins",
          );
      }
    };
    void refresh();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (catalog?.scan.state !== "scanning") return;
    const timer = setInterval(() => {
      void pluginCatalogApi
        .list()
        .then(setCatalog)
        .catch((error: unknown) => {
          setRequestError(
            error instanceof Error
              ? error.message
              : "Could not refresh scan state",
          );
        });
    }, 750);
    return () => clearInterval(timer);
  }, [catalog?.scan.state]);

  const beginScan = async (rescanAll: boolean) => {
    try {
      setRequestError("");
      await pluginCatalogApi.scan(rescanAll);
      const next = await pluginCatalogApi.list();
      setCatalog(next);
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Could not start scan",
      );
    }
  };

  const cancelScan = async () => {
    try {
      setRequestError("");
      await pluginCatalogApi.cancelScan();
      setCatalog(await pluginCatalogApi.list());
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Could not cancel scan",
      );
    }
  };

  const setPluginEnabled = async (
    plugin: PluginCatalogEntry,
    enabled: boolean,
  ) => {
    setCatalog((current) =>
      current === null
        ? current
        : {
            ...current,
            catalog: {
              ...current.catalog,
              plugins: current.catalog.plugins.map((candidate) =>
                candidate.id === plugin.id
                  ? { ...candidate, enabled }
                  : candidate,
              ),
            },
          },
    );
    try {
      await pluginCatalogApi.setEnabled(plugin.id, enabled);
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Could not update plug-in",
      );
      setCatalog(await pluginCatalogApi.list());
    }
  };

  const plugins = catalog?.catalog.plugins;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const families = useMemo(() => groupPluginFamilies(plugins ?? []), [plugins]);
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const family of families) {
      const variants = family.variants;
      const matchesScope =
        scopeFilter === "all" ||
        (scopeFilter === "effects" &&
          variants.some(
            (plugin) => !plugin.instrument && (plugin.inputs ?? 2) > 0,
          )) ||
        (scopeFilter === "instruments" &&
          variants.some((plugin) => plugin.instrument)) ||
        (scopeFilter === "multi-io" &&
          variants.some(
            (plugin) => (plugin.inputs ?? 2) > 2 || (plugin.outputs ?? 2) > 2,
          )) ||
        (scopeFilter === "new" && variants.some((plugin) => plugin.isNew));
      if (!matchesScope) continue;
      const catKey = family.category.toLowerCase();
      counts.set(catKey, (counts.get(catKey) ?? 0) + 1);
    }
    return counts;
  }, [families, scopeFilter]);

  const availableCategories = useMemo(() => {
    return GLOBAL_CATEGORIES.filter((cat) => {
      if (cat.id === "all") return true;
      const count = categoryCounts.get(cat.id) ?? 0;
      return count > 0 || categoryFilter === cat.id;
    });
  }, [categoryCounts, categoryFilter]);

  const filtered = useMemo(
    () =>
      families.filter((family) => {
        if (scopeFilter === "quarantined") return false;
        const variants = family.variants;
        const matchesScope =
          scopeFilter === "all" ||
          (scopeFilter === "effects" &&
            variants.some(
              (plugin) => !plugin.instrument && (plugin.inputs ?? 2) > 0,
            )) ||
          (scopeFilter === "instruments" &&
            variants.some((plugin) => plugin.instrument)) ||
          (scopeFilter === "multi-io" &&
            variants.some(
              (plugin) => (plugin.inputs ?? 2) > 2 || (plugin.outputs ?? 2) > 2,
            )) ||
          (scopeFilter === "new" && variants.some((plugin) => plugin.isNew));
        if (!matchesScope) return false;

        const matchesCategory =
          categoryFilter === "all" ||
          family.category.toLowerCase() === categoryFilter.toLowerCase();
        if (!matchesCategory) return false;

        if (!normalizedQuery) return true;
        return variants.some((plugin) =>
          [
            plugin.name,
            plugin.manufacturer,
            family.category,
            plugin.category,
            plugin.format,
          ].some((value) =>
            Boolean(
              value && value.toLocaleLowerCase().includes(normalizedQuery),
            ),
          ),
        );
      }),
    [families, scopeFilter, categoryFilter, normalizedQuery],
  );

  const quarantined = useMemo(
    () =>
      (catalog?.catalog.blacklist ?? []).filter(
        (item) =>
          scopeFilter === "quarantined" &&
          (!normalizedQuery ||
            item.toLocaleLowerCase().includes(normalizedQuery)),
      ),
    [catalog?.catalog.blacklist, scopeFilter, normalizedQuery],
  );

  const visible = filtered.slice(0, 250);
  const scanning = catalog?.scan.state === "scanning";
  const resultCount =
    scopeFilter === "quarantined" ? quarantined.length : filtered.length;
  const newCount = (plugins ?? []).filter((plugin) => plugin.isNew).length;
  const quarantinedCount = catalog?.catalog.blacklist.length ?? 0;

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden">
      <Card.Header className="shrink-0 gap-3.5 border-b border-default/20 px-6 py-4">
        <PluginScanControls
          catalog={catalog}
          pluginCount={plugins?.length ?? 0}
          familyCount={families.length}
          quarantinedCount={quarantinedCount}
          scanning={scanning}
          requestError={requestError}
          query={query}
          onQueryChange={setQuery}
          onBeginScan={beginScan}
          onCancelScan={cancelScan}
        />
        <PluginCatalogFilters
          scopeFilter={scopeFilter}
          onScopeFilterChange={setScopeFilter}
          categoryFilter={categoryFilter}
          onCategoryFilterChange={setCategoryFilter}
          categoryCounts={categoryCounts}
          availableCategories={availableCategories}
          newCount={newCount}
          quarantinedCount={quarantinedCount}
        />
      </Card.Header>

      <PluginCatalogResults
        catalog={catalog}
        scopeFilter={scopeFilter}
        resultCount={resultCount}
        quarantined={quarantined}
        visibleFamilies={visible}
        totalFamilyCount={filtered.length}
        onPluginEnabledChange={setPluginEnabled}
      />
    </Card>
  );
}
