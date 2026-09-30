import { Plug, Search, Square, X } from "lucide-react";
import { Alert, Button, Card } from "@/components/ui";
import type { PluginCatalogResponse } from "@/lib/state/api";

export function PluginScanControls({
  catalog,
  pluginCount,
  familyCount,
  quarantinedCount,
  scanning,
  requestError,
  query,
  onQueryChange,
  onBeginScan,
  onCancelScan,
}: {
  catalog: PluginCatalogResponse | null;
  pluginCount: number;
  familyCount: number;
  quarantinedCount: number;
  scanning: boolean;
  requestError: string;
  query: string;
  onQueryChange: (query: string) => void;
  onBeginScan: (rescanAll: boolean) => void;
  onCancelScan: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Card.Title>Audio Plug-ins</Card.Title>
          <p className="truncate text-[11px] text-foreground/45">
            Isolated VST3/AU discovery · disabled items stay out of insert menus
          </p>
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-foreground/50">
          {pluginCount} plug-ins · {familyCount} families · {quarantinedCount} quarantined
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          isDisabled={scanning}
          onPress={() => void onBeginScan(false)}
        >
          <Plug size={14} />
          {scanning ? "Scanning…" : "Scan new or changed"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          isDisabled={scanning}
          onPress={() => void onBeginScan(true)}
        >
          Rescan all
        </Button>
        {scanning && (
          <Button
            size="sm"
            variant="danger-soft"
            onPress={() => void onCancelScan()}
          >
            <Square size={12} fill="currentColor" />
            Cancel
          </Button>
        )}
        <label className="relative ml-auto min-w-56 flex-1 sm:max-w-sm">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground/35"
          />
          <input
            aria-label="Search plug-ins"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Name, vendor, category, format…"
            className="h-8 w-full rounded-lg border border-default/35 bg-default/15 pl-9 pr-8 text-xs outline-none transition-colors focus:border-accent"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear plug-in search"
              onClick={() => onQueryChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-foreground"
            >
              <X size={14} />
            </button>
          )}
        </label>
      </div>

      {scanning && catalog && (
        <div className="grid gap-1" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-[11px] text-foreground/55">
            <span className="truncate">
              Stage {catalog.scan.formatIndex || 1} of{" "}
              {catalog.scan.formatCount || "…"} ·{" "}
              {catalog.scan.format || "Preparing scanner"}
            </span>
            <span className="shrink-0 tabular-nums">
              {Math.round((catalog.scan.progress ?? 0) * 100)}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-default/30">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{
                width: `${Math.max(1, Math.min(100, (catalog.scan.progress ?? 0) * 100))}%`,
              }}
            />
          </div>
          <div className="truncate text-xs text-foreground/50">
            {catalog.scan.currentPlugin || "Finding installed plug-ins…"}
          </div>
        </div>
      )}

      {(requestError || catalog?.scan.error) && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>
              {requestError || catalog?.scan.error}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
    </>
  );
}
