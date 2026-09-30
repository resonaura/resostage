import { useEffect, useState } from "react";
import {
  pluginCatalog as pluginCatalogApi,
  type PluginCatalogEntry,
} from "@/lib/state/api";

/**
 * Shares one device-local plug-in catalog request across all mixer strips.
 * While a scan is active, the returned catalog is refreshed until it finishes.
 */
export function usePluginCatalog(active: boolean): PluginCatalogEntry[] {
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);

  // The catalog is device-local structural state, so load it once for every
  // strip instead of making each insert rack poll Core. If a scan is active,
  // keep the single shared copy fresh until the helper finishes.
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      void pluginCatalogApi
        .list()
        .then((response) => {
          if (disposed) return;
          setCatalog(response.catalog.plugins);
          if (response.scan.state === "scanning") {
            timer = setTimeout(refresh, 1500);
          }
        })
        .catch(() => {
          // An unavailable catalog leaves explicit empty insert slots. The
          // reliable settings screen owns scan errors and retry controls, but
          // keep this one shared request recoverable across a Core restart or
          // remote host switch instead of leaving the rack empty forever.
          if (!disposed) timer = setTimeout(refresh, 3000);
        });
    };
    refresh();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [active]);

  return catalog;
}
