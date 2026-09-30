import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Plus,
  RotateCw,
  Power,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  builder,
  pluginCatalog,
  pluginChains,
  type PluginCatalogResponse,
} from "../../../lib/state/api";
import { createEditGesture } from "../../../lib/interaction/editGesture";
import type { PluginSlotRow, SongRow, TrackRow } from "../../../lib/state/types";
import { Alert, Button, Modal } from "../../../components/ui";
import { AutomationMiniGraph } from "./components/AutomationMiniGraph";
import {
  deduplicatePlugins,
  displayFormat,
} from "../../../lib/plugins/pluginCategories";

export function PluginChainModal({
  open,
  stripId,
  stripName,
  slots,
  track,
  song,
  songIndex = 0,
  onClose,
}: {
  open: boolean;
  stripId: string;
  stripName: string;
  slots: PluginSlotRow[];
  track?: TrackRow;
  song?: SongRow;
  songIndex?: number;
  onClose: () => void;
}) {
  const [catalog, setCatalog] = useState<PluginCatalogResponse | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [draggedSlotId, setDraggedSlotId] = useState<string | null>(null);
  const [rightMode, setRightMode] = useState<"effects" | "automation">("effects");
  const [automationSlotId, setAutomationSlotId] = useState("");
  const [automationParameters, setAutomationParameters] = useState<Array<{
    index: number; name: string; label: string; defaultValue: number; steps: number;
  }>>([]);
  const [automationParameterIndex, setAutomationParameterIndex] = useState<number | null>(null);
  const [automationSearch, setAutomationSearch] = useState("");
  const [automationError, setAutomationError] = useState("");
  const editGesture = useRef(createEditGesture()).current;
  const effects = slots.filter((slot) => !slot.instrument);
  const instrument = slots.find((slot) => slot.instrument);
  const chainTitle = instrument ? "Instrument & FX" : "Audio FX";
  const automationSlot = slots.find((slot) => slot.id === automationSlotId) ?? null;

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

  useEffect(() => {
    if (!slots.some((slot) => slot.id === automationSlotId))
      setAutomationSlotId(slots.find((slot) => slot.loadState === "loaded")?.id ?? slots[0]?.id ?? "");
  }, [automationSlotId, slots]);

  useEffect(() => {
    if (!open || !automationSlotId) {
      setAutomationParameters([]);
      return;
    }
    let disposed = false;
    setAutomationError("");
    void pluginChains.parameters(automationSlotId)
      .then((response) => {
        if (disposed) return;
        setAutomationParameters(response.parameters);
        setAutomationParameterIndex((current) =>
          current !== null && response.parameters.some((parameter) => parameter.index === current)
            ? current
            : response.parameters[0]?.index ?? null,
        );
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setAutomationParameters([]);
          setAutomationError(reason instanceof Error ? reason.message : "Could not read plug-in parameters");
        }
      });
    return () => { disposed = true; };
  }, [automationSlotId, automationSlot?.loadState, open]);

  const knownIds = useMemo(
    () => new Set((catalog?.catalog.plugins ?? []).map((plugin) => plugin.id)),
    [catalog],
  );
  const normalized = query.trim().toLocaleLowerCase();
  const available = useMemo(() => {
    const nonInstruments = (catalog?.catalog.plugins ?? []).filter(
      (plugin) => !plugin.instrument,
    );
    const deduplicated = deduplicatePlugins(nonInstruments);
    return deduplicated
      .filter((plugin) => {
        if (!normalized) return true;
        return [
          plugin.name,
          plugin.manufacturer,
          plugin.category,
          displayFormat(plugin.format),
          plugin.format,
        ].some((field) =>
          Boolean(field && field.toLocaleLowerCase().includes(normalized)),
        );
      })
      .slice(0, 200);
  }, [catalog, normalized]);

  const filteredAutomationParameters = automationParameters.filter((parameter) =>
    `${parameter.name} ${parameter.label}`.toLocaleLowerCase().includes(automationSearch.trim().toLocaleLowerCase()),
  );
  const selectedParameter = automationParameters.find(
    (parameter) => parameter.index === automationParameterIndex,
  ) ?? null;
  const automationLanes = (song?.automationLanes ?? []).filter(
    (lane) => lane.target.domain === "plugin" && slots.some((slot) => slot.id === lane.target.entityId),
  );
  const selectedAutomationLane = automationSlot && selectedParameter
    ? automationLanes.find((lane) => lane.target.entityId === automationSlot.id
      && lane.target.parameterId === `param:${selectedParameter.index}`)
    : undefined;

  const addAutomationLane = async () => {
    if (!automationSlot || !selectedParameter || !song) return;
    try {
      setAutomationError("");
      await builder.automationLaneAdd({
        songIndex,
        domain: "plugin",
        entityId: automationSlot.id,
        parameterId: `param:${selectedParameter.index}`,
        valueType: "floatNormalized",
        defaultValue: selectedParameter.defaultValue,
        minValue: 0,
        maxValue: 1,
        scope: "track",
        writeMode: "read",
        initialTimeBeats: 0,
        initialValue: selectedParameter.defaultValue,
        gestureId: editGesture.id(),
      });
    } catch (reason) {
      setAutomationError(reason instanceof Error ? reason.message : "Could not add automation lane");
    }
  };

  if (!open) return null;

  return (
    <Modal isOpen={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <Modal.Backdrop>
        <Modal.Container size="3xl" placement="center" scroll="inside">
          <Modal.Dialog
            aria-label={`${chainTitle} for ${stripName}`}
            className="max-h-[86vh] rounded-xl border border-default/40 p-0 shadow-2xl"
          >
            <Modal.Header className="flex items-center justify-between border-b border-default/20 px-5 py-4">
              <div className="min-w-0">
                <Modal.Heading className="truncate text-base font-bold">
                  {chainTitle} · {stripName}
                </Modal.Heading>
                <p className="mt-1 text-xs text-foreground/45">
                  Post-input, pre-fader. Order is top to bottom.
                </p>
              </div>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={`Close ${chainTitle}`}
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
                    {effects.length}/32 audio effects
                  </span>
                </div>
                {track && (
                  <div className="mb-3 space-y-2 text-xs">
                    <div className="rounded-lg border border-default/30 bg-surface-secondary px-3 py-2">
                      Input · {track.kind === "audio" ? (track.inputSource || "No Input") : (track.midiInputDevice || "MIDI inputs")}
                    </div>
                    {track.kind === "instrument" && (
                      <div className="rounded-lg border border-default/30 bg-surface-secondary px-3 py-2">
                        Instrument · {instrument?.name || "No instrument"}
                      </div>
                    )}
                  </div>
                )}
                {effects.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-default/35 px-4 py-10 text-center text-sm text-foreground/45">
                    No effects. Choose one from the catalog.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {effects.map((slot, index) => {
                      const missing = !knownIds.has(slot.pluginId);
                      return (
                        <div
                          key={slot.id}
                          draggable
                          onDragStart={(event) => {
                            setDraggedSlotId(slot.id);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", slot.id);
                          }}
                          onDragOver={(event) => {
                            if (!draggedSlotId || draggedSlotId === slot.id) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            const sourceId = draggedSlotId;
                            setDraggedSlotId(null);
                            if (!sourceId || sourceId === slot.id) return;
                            // Slot zero is the generator on instrument tracks.
                            void pluginChains.move(stripId, sourceId, index + (instrument ? 1 : 0));
                          }}
                          onDragEnd={() => setDraggedSlotId(null)}
                          className={`flex items-center gap-2 rounded-lg border p-2.5 ${
                            slot.bypassed
                              ? "border-default/20 bg-default/5 opacity-60"
                              : "border-foreground/55 bg-foreground/12"
                          }`}
                        >
                          <span className="w-5 shrink-0 text-center font-mono text-[10px] text-foreground/35">
                            {index + 1}
                          </span>
                          <div
                            className="min-w-0 flex-1 cursor-pointer select-none"
                            title={`Open ${slot.name} editor`}
                            onClick={() =>
                              void pluginChains.openEditor(stripId, slot.id)
                            }
                          >
                            <div className="truncate text-xs font-semibold hover:text-accent transition-colors">
                              {slot.name || "Unknown plug-in"}
                            </div>
                            <div className="truncate text-[10px] text-foreground/40">
                              {slot.manufacturer || "Unknown vendor"} ·{" "}
                              {displayFormat(slot.format)}
                              {missing ? " · unavailable on this Core" : ""}
                              {slot.loadState === "loading" ? " · loading…" : ""}
                              {slot.loadState === "failed" ? " · failed to load" : ""}
                              {slot.hasState ? " · state saved" : ""}
                            </div>
                            {slot.loadError && slot.loadState !== "loaded" && (
                              <div className="mt-1 line-clamp-2 text-[10px] text-danger/80" title={slot.loadError}>
                                {slot.loadError}
                              </div>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {(slot.loadState === "failed" || slot.loadState === "missing") && (
                              <Button
                                isIconOnly
                                size="sm"
                                variant="outline"
                                aria-label={`Retry loading ${slot.name}`}
                                onPress={() => void pluginChains.retry(stripId, slot.id)}
                              >
                                <RotateCw size={14} />
                              </Button>
                            )}
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={`Open ${slot.name} editor window`}
                              onPress={() =>
                                void pluginChains.openEditor(stripId, slot.id)
                              }
                            >
                              <ExternalLink size={14} />
                            </Button>
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
                                  index - 1 + (instrument ? 1 : 0),
                                  -1,
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
                              isDisabled={index === effects.length - 1}
                              onPress={() =>
                                void pluginChains.move(
                                  stripId,
                                  slot.id,
                                  index + 1 + (instrument ? 1 : 0),
                                  1,
                                )
                              }
                            >
                              <ChevronDown size={14} />
                            </Button>
                            <Button
                              isIconOnly
                              size="sm"
                              variant={
                                slot.bypassed ? "outline" : "accent-soft"
                              }
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
                {track && (
                  <div className="mt-3 rounded-lg border border-default/30 bg-surface-secondary px-3 py-2 text-xs">
                    Output · {track.output.type === "main" ? "Main" :
                      track.output.type === "sends-only" ? "Sends only" :
                      `${track.output.type === "bus" ? "Bus" : "External"}: ${track.output.target || "—"}`}
                  </div>
                )}
              </section>

              <aside className="flex min-h-0 flex-col border-t border-default/20 bg-default/10 p-5 md:border-l md:border-t-0">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setRightMode("effects")}
                    className={`rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-wide ${rightMode === "effects" ? "bg-accent/15 text-accent" : "text-foreground/45 hover:text-foreground"}`}>
                    Add effect
                  </button>
                  <button type="button" onClick={() => setRightMode("automation")}
                    className={`rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-wide ${rightMode === "automation" ? "bg-accent/15 text-accent" : "text-foreground/45 hover:text-foreground"}`}>
                    Automation
                  </button>
                </div>
                {rightMode === "effects" ? <>
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
                            {plugin.manufacturer || "Unknown vendor"} ·{" "}
                            {displayFormat(plugin.format)}
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
                {(catalog?.catalog.plugins ?? []).some((plugin) => plugin.instrument) && (
                  <p className="mt-3 text-[10px] leading-relaxed text-foreground/40">
                    This catalog adds audio effects. Choose the generator from
                    the track’s Instrument slot.
                  </p>
                )}
                </> : <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  {!song ? (
                    <p className="text-xs text-foreground/45">Automation is available from the Editor.</p>
                  ) : slots.length === 0 ? (
                    <p className="text-xs text-foreground/45">Add a plug-in to this chain first.</p>
                  ) : <>
                    <label className="grid gap-1 text-[10px] font-semibold uppercase tracking-wide text-foreground/45">
                      Plug-in
                      <select value={automationSlotId} onChange={(event) => setAutomationSlotId(event.target.value)}
                        className="h-9 rounded-lg border border-default/35 bg-surface px-2 text-xs font-normal normal-case text-foreground outline-none focus:border-accent">
                        {slots.map((slot) => <option key={slot.id} value={slot.id}>{slot.name || "Unknown plug-in"}</option>)}
                      </select>
                    </label>
                    <input value={automationSearch} onChange={(event) => setAutomationSearch(event.target.value)}
                      placeholder="Find a parameter…" aria-label="Search plug-in parameters"
                      className="h-9 rounded-lg border border-default/35 bg-surface px-3 text-xs outline-none focus:border-accent" />
                    {automationSlot?.loadState !== "loaded" ? (
                      <p className="text-xs text-foreground/45">Waiting for the isolated plug-in host to finish loading this plug-in…</p>
                    ) : automationParameters.length === 0 ? (
                      <p className="text-xs text-foreground/45">{automationError || "This plug-in exposes no automatable parameters."}</p>
                    ) : (
                      <div className="min-h-0 max-h-40 overflow-y-auto rounded-lg border border-default/25 bg-surface">
                        {filteredAutomationParameters.map((parameter) => (
                          <button type="button" key={parameter.index}
                            onClick={() => setAutomationParameterIndex(parameter.index)}
                            className={`flex w-full items-center justify-between gap-2 border-b border-default/15 px-2.5 py-2 text-left last:border-b-0 ${automationParameterIndex === parameter.index ? "bg-accent/10 text-accent" : "hover:bg-default/10"}`}>
                            <span className="min-w-0 truncate text-xs">{parameter.name}</span>
                            <span className="shrink-0 text-[10px] text-foreground/40">{parameter.label || `#${parameter.index + 1}`}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedParameter && (
                      <div className="rounded-lg border border-default/25 bg-surface p-2.5">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold">{selectedParameter.name}</div>
                            <div className="text-[10px] text-foreground/40">Normalized plug-in parameter</div>
                          </div>
                          {selectedAutomationLane ? (
                            <Button size="sm" variant="danger-soft" onPress={() => void builder.automationLaneRemove(songIndex, selectedAutomationLane.id, editGesture.id())}>
                              <Trash2 size={12} /> Remove
                            </Button>
                          ) : (
                            <Button size="sm" variant="accent-soft" onPress={() => void addAutomationLane()}>
                              <Plus size={12} /> Add lane
                            </Button>
                          )}
                        </div>
                        {selectedAutomationLane && (
                          <AutomationMiniGraph lane={selectedAutomationLane} song={song!} songIndex={songIndex} parameterSteps={selectedParameter.steps} />
                        )}
                      </div>
                    )}
                    {automationError && <p className="text-[10px] text-danger">{automationError}</p>}
                    <p className="text-[10px] leading-relaxed text-foreground/40">
                      Click the curve to add a point, drag to edit it, or Option-click to remove. Parameter names come from the isolated host; plug-in failures remain contained there.
                    </p>
                  </>}
                </div>}
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
