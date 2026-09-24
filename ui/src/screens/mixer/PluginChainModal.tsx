import {
  ChevronDown,
  ChevronUp,
  Plus,
  Power,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  pluginCatalog,
  pluginChains,
  type PluginCatalogResponse,
} from "../../lib/api";
import type { PluginSlotRow } from "../../lib/types";
import { Alert, Button, Modal } from "../../components/ui";

export function PluginChainModal({
  open,
  stripId,
  stripName,
  slots,
  onClose,
}: {
  open: boolean;
  stripId: string;
  stripName: string;
  slots: PluginSlotRow[];
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<PluginCatalogResponse | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void pluginCatalog
      .list()
      .then((value) => {
        if (!disposed) {
          setCatalog(value);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (!disposed)
          setError(
            reason instanceof Error ? reason.message : "Could not load catalog",
          );
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const knownIds = useMemo(
    () => new Set((catalog?.catalog.plugins ?? []).map((plugin) => plugin.id)),
    [catalog],
  );
  const normalized = query.trim().toLocaleLowerCase();
  const available = useMemo(
    () =>
      (catalog?.catalog.plugins ?? [])
        .filter((plugin) => !plugin.instrument)
        .filter((plugin) => {
          if (!normalized) return true;
          return [
            plugin.name,
            plugin.manufacturer,
            plugin.category,
            plugin.format,
          ].some((field) => field.toLocaleLowerCase().includes(normalized));
        })
        .slice(0, 200),
    [catalog, normalized],
  );

  if (!open) return null;

  return (
    <Modal isOpen={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center" scroll="inside">
          <Modal.Dialog
            aria-label={`Insert effects for ${stripName}`}
            className="max-h-[86vh] rounded-xl border border-default/40 p-0 shadow-2xl"
          >
            <Modal.Header className="flex items-center justify-between border-b border-default/20 px-5 py-4">
              <div className="min-w-0">
                <Modal.Heading className="truncate text-base font-bold">
                  Insert effects · {stripName}
                </Modal.Heading>
                <p className="mt-1 text-xs text-foreground/45">
                  Post-input, pre-fader. Order is top to bottom.
                </p>
              </div>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="Close insert effects"
                onPress={onClose}
              >
                <X size={16} />
              </Button>
            </Modal.Header>

            <Modal.Body className="grid min-h-0 gap-0 overflow-hidden p-0 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.8fr)]">
              <section className="min-h-0 overflow-y-auto p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-[11px] font-bold uppercase tracking-wide text-foreground/55">
                    Chain
                  </h3>
                  <span className="text-[10px] text-foreground/40">
                    {slots.length}/32 inserts
                  </span>
                </div>
                {slots.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-default/35 px-4 py-10 text-center text-sm text-foreground/45">
                    No effects. Choose one from the catalog.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {slots.map((slot, index) => {
                      const missing = !knownIds.has(slot.pluginId);
                      return (
                        <div
                          key={slot.id}
                          className={`flex items-center gap-2 rounded-lg border p-2.5 ${
                            slot.bypassed
                              ? "border-default/20 bg-default/5 opacity-60"
                              : "border-default/30 bg-surface-secondary"
                          }`}
                        >
                          <span className="w-5 shrink-0 text-center font-mono text-[10px] text-foreground/35">
                            {index + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-semibold">
                              {slot.name || "Unknown plug-in"}
                            </div>
                            <div className="truncate text-[10px] text-foreground/40">
                              {slot.manufacturer || "Unknown vendor"} · {slot.format}
                              {missing ? " · unavailable on this Core" : ""}
                              {slot.hasState ? " · state saved" : ""}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={`Move ${slot.name} up`}
                              isDisabled={index === 0}
                              onPress={() =>
                                void pluginChains.move(
                                  stripId,
                                  slot.id,
                                  index - 1,
                                )
                              }
                            >
                              <ChevronUp size={14} />
                            </Button>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={`Move ${slot.name} down`}
                              isDisabled={index === slots.length - 1}
                              onPress={() =>
                                void pluginChains.move(
                                  stripId,
                                  slot.id,
                                  index + 1,
                                )
                              }
                            >
                              <ChevronDown size={14} />
                            </Button>
                            <Button
                              isIconOnly
                              size="sm"
                              variant={slot.bypassed ? "outline" : "accent-soft"}
                              aria-label={`${slot.bypassed ? "Enable" : "Bypass"} ${slot.name}`}
                              onPress={() =>
                                void pluginChains.setBypassed(
                                  stripId,
                                  slot.id,
                                  !slot.bypassed,
                                )
                              }
                            >
                              <Power size={14} />
                            </Button>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="danger-soft"
                              aria-label={`Remove ${slot.name}`}
                              onPress={() =>
                                void pluginChains.remove(stripId, slot.id)
                              }
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <aside className="flex min-h-0 flex-col border-t border-default/20 bg-default/10 p-5 md:border-l md:border-t-0">
                <h3 className="text-[11px] font-bold uppercase tracking-wide text-foreground/55">
                  Add effect
                </h3>
                <label className="relative mt-3 block">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground/35"
                  />
                  <input
                    aria-label="Search effect plug-ins"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Name, vendor, format…"
                    className="h-9 w-full rounded-lg border border-default/35 bg-surface pl-9 pr-3 text-xs outline-none transition-colors focus:border-accent"
                  />
                </label>
                {error && (
                  <Alert status="danger" className="mt-3">
                    <Alert.Content>
                      <Alert.Description>{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}
                <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-default/25 bg-surface">
                  {available.length === 0 ? (
                    <div className="px-4 py-8 text-center text-xs text-foreground/45">
                      {catalog === null
                        ? "Loading catalog…"
                        : "No matching effect plug-ins. Scan in Settings → Plug-ins."}
                    </div>
                  ) : (
                    available.map((plugin) => (
                      <div
                        key={plugin.id}
                        className="flex items-center gap-2 border-b border-default/20 px-3 py-2 last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">
                            {plugin.name}
                          </div>
                          <div className="truncate text-[10px] text-foreground/40">
                            {plugin.manufacturer || "Unknown vendor"} · {plugin.format}
                          </div>
                        </div>
                        <Button
                          isIconOnly
                          size="sm"
                          variant="outline"
                          aria-label={`Add ${plugin.name}`}
                          isDisabled={slots.length >= 32}
                          onPress={() =>
                            void pluginChains.add(stripId, plugin.id)
                          }
                        >
                          <Plus size={14} />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
                {(catalog?.catalog.plugins ?? []).some(
                  (plugin) => plugin.instrument,
                ) && (
                  <p className="mt-3 text-[10px] leading-relaxed text-foreground/40">
                    Instruments are hidden until MIDI instrument tracks are available;
                    this chain hosts audio effects only.
                  </p>
                )}
              </aside>
            </Modal.Body>

            <Modal.Footer className="flex justify-end border-t border-default/20 px-5 py-3">
              <Button variant="ghost" onPress={onClose}>
                Done
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
