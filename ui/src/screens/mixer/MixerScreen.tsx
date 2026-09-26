import { ScrollShadow } from "@heroui/react";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui";
import type { RenderDialogIntent } from "../../components/RenderAudioDialog";
import { useHorizontalWindow } from "../../hooks/useHorizontalWindow";
import {
  builder,
  mixer,
  pluginCatalog as pluginCatalogApi,
  type PluginCatalogEntry,
} from "../../lib/api";
import { outputSendsToClickRows, type WebUiState } from "../../lib/types";
import { useIsCompact } from "../../lib/useMediaQuery";
import { BusStrip } from "./BusStrip";
import { MetronomeStrip } from "./MetronomeStrip";
import { PluginChainModal } from "./PluginChainModal";
import { extOutTarget, isMainBusId } from "./mixerIds";
import { patchClickFields } from "./mixerUtils";
import { StripContextMenu, type StripMenuTarget } from "./StripContextMenu";
import { TrackStrip } from "./TrackStrip";

interface PendingBusJob {
  knownIds: Set<string>;
  finalize: (busId: string, index: number) => void;
}

interface PluginTarget {
  stripId: string;
  stripName: string;
}

export type MixerDensity = "narrow" | "standard" | "wide";

/**
 * Density-dependent strip pitch: strip width + 8px gap.
 * Narrow: 64px + 8px = 72px
 * Standard: 96px + 8px = 104px
 * Wide: 128px + 8px = 136px
 */
const DENSITY_PITCH_MAP: Record<MixerDensity, number> = {
  narrow: 72,
  standard: 104,
  wide: 136,
};

/**
 * Below this many strips, mount the lot.
 *
 * Windowing is only ever a saving for strips that are off screen, and a pane
 * this short has none on any normal window -- so the threshold costs nothing
 * and keeps small rigs on the simplest possible path. Raise or drop it freely;
 * the windowed and unwindowed renders are identical when everything fits.
 */
const VIRTUALIZE_FROM = 12;

/**
 * One group of strips (tracks / sends / master).
 *
 * On a desktop console each group is its own horizontal scroller so the master
 * stays pinned on the right while the track pane scrolls under it. That
 * division needs width to make sense: on a phone the master and sends alone
 * eat the entire viewport and the track pane collapses to a sliver. There, the
 * groups stop scrolling individually and the console becomes one continuous
 * strip you swipe through -- the same order, just laid end to end.
 */
function ConsolePane({
  compact,
  className,
  children,
}: {
  compact: boolean;
  className: string;
  children: React.ReactNode;
}) {
  if (compact) return <div className={className}>{children}</div>;
  return (
    <ScrollShadow orientation="horizontal" className={`${className} overflow-y-auto`}>
      {children}
    </ScrollShadow>
  );
}

export function MixerScreen({
  state,
  active,
  onRender,
}: {
  state: WebUiState;
  active: boolean;
  onRender: (intent: RenderDialogIntent) => void;
}) {
  const compact = useIsCompact();
  const [density, setDensity] = useState<MixerDensity>(() => {
    try {
      const saved = localStorage.getItem("resostage:mixer-density");
      if (saved === "narrow" || saved === "standard" || saved === "wide") return saved;
    } catch {}
    return "standard";
  });

  const handleDensityChange = (d: MixerDensity) => {
    setDensity(d);
    try {
      localStorage.setItem("resostage:mixer-density", d);
    } catch {}
  };

  const auxBusses = state.busses.filter((b) => b.isAux);
  const pitchPx = DENSITY_PITCH_MAP[density];
  const trackWindow = useHorizontalWindow({
    count: state.tracks.length,
    pitchPx,
    enabled: state.tracks.length >= VIRTUALIZE_FROM,
  });
  const sendWindow = useHorizontalWindow({
    count: auxBusses.length,
    pitchPx,
    enabled: auxBusses.length >= VIRTUALIZE_FROM,
  });
  // Match the master by its canonical id and nothing else. The old code fell
  // back to "the first non-aux bus" when the id didn't match, which quietly
  // selected an output LANE -- so every control on the master strip was being
  // addressed to the wrong bus index.
  const master = state.busses.find((b) => isMainBusId(b.id));
  const masterBusses = master ? [master] : [];
  // Track destination list: master + aux only (no hidden Ext. Out sub-buses).
  // Aux → aux is never offered as a main destination here; track sends only
  // target aux via SendKnobs (no send→send loop).
  const destinationBusses = state.busses.filter(
    (b) => isMainBusId(b.id) || b.isAux,
  );
  const pendingBusJobs = useRef<PendingBusJob[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [menu, setMenu] = useState<StripMenuTarget | null>(null);
  const [pluginTarget, setPluginTarget] = useState<PluginTarget | null>(null);
  const [effectCatalog, setEffectCatalog] = useState<PluginCatalogEntry[]>([]);

  const openPlugins = useCallback((stripId: string, stripName: string) => {
    setPluginTarget({ stripId, stripName });
  }, []);

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
          setEffectCatalog(response.catalog.plugins);
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

  useEffect(() => {
    if (pendingBusJobs.current.length === 0) return;
    const claimed = new Set<string>();
    const remaining: PendingBusJob[] = [];
    for (const job of pendingBusJobs.current) {
      const idx = state.busses.findIndex(
        (b) => !job.knownIds.has(b.id) && !claimed.has(b.id),
      );
      if (idx >= 0) {
        claimed.add(state.busses[idx].id);
        job.finalize(state.busses[idx].id, idx);
      } else {
        remaining.push(job);
      }
    }
    pendingBusJobs.current = remaining;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.busses]);

  function queueBusJob(finalize: (busId: string, index: number) => void) {
    pendingBusJobs.current.push({
      knownIds: new Set(state.busses.map((b) => b.id)),
      finalize,
    });
    void builder.busAdd();
  }

  function requestAddSend() {
    const label = `Send ${auxBusses.length + 1}`;
    // A freshly-added send points at Master (same outs as master) so its
    // destination reads "Master" by default, not an awkward Ext. Out on some
    // stray free channel (which made a just-added send look broken/unrouted).
    const startChannel = master?.startChannel ?? 0;
    queueBusJob((_busId, index) => {
      void builder.busUpdate({
        index,
        name: label,
        channels: 2,
        startChannel,
        gainDb: 0,
        mute: false,
        solo: false,
        isAux: true,
      });
    });
  }

  /**
   * Output lanes are fabricated by the engine from the device's active output
   * channels (never persisted — see BusRow.isDirectOut). Lanes are always
   * mono, so a stereo pick is a pair of them. We only ever route to these —
   * never create project busses for Ext. Out.
   */
  function directBusIdFor(startChannel: number, pair: boolean): string {
    return extOutTarget(startChannel, pair);
  }

  // Stable identities: every strip is memoised (see TrackStrip), and a handler
  // rebuilt each render would defeat that on its own.
  const requestTrackDirectOutput = useCallback(
    (
      trackIndex: number,
      _mono: boolean,
      startChannel: number,
      pair: boolean,
    ) => {
      // Always switch: the lane id is deterministic from the channel and the
      // engine's routing drops any lane that isn't currently present (shadow /
      // unavailable) to silence without rejecting. Gating on the live bus list
      // here made Ext. Out feel dead on tracks (race the moment a lane isn't
      // yet in state.busses), while master -- a plain project bus -- always
      // switched fine.
      void mixer.setTrackBus(trackIndex, directBusIdFor(startChannel, pair));
    },
    [],
  );

  const requestClickDirectOutput = useCallback(
    (startChannel: number, pair: boolean) => {
      patchClickFields(stateRef.current, {
        clickBusId: directBusIdFor(startChannel, pair),
      });
    },
    [],
  );

  // Solo grouping is the engine's rule, not the mixer's: every row arrives
  // tagged with its group and whether anything in that group is soloed, so a
  // strip is drawn dimmed for exactly the reason it is actually silenced.
  const anyTrackSolo =
    state.tracks.some((tr) => tr.soloActiveInGroup) ||
    (state.click?.soloActiveInGroup ?? false);
  const anyAuxSolo = auxBusses.some((b) => b.soloActiveInGroup);
  const songIndex = state.songIndex >= 0 ? state.songIndex : 0;
  const clickSends = state.click
    ? outputSendsToClickRows(state.click.output)
    : [];

  // Smart aligned mixer racks: align Audio FX slot rows horizontally across the mixer
  const maxPluginSlots = useMemo(() => {
    let maxCount = 0;
    for (const t of state.tracks) {
      if (t.plugins && t.plugins.length > maxCount) maxCount = t.plugins.length;
    }
    for (const b of state.busses) {
      if (b.plugins && b.plugins.length > maxCount) maxCount = b.plugins.length;
    }
    if (state.click?.plugins && state.click.plugins.length > maxCount) {
      maxCount = state.click.plugins.length;
    }
    return Math.max(1, maxCount) + 1;
  }, [state.tracks, state.busses, state.click?.plugins]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between text-xs text-foreground/40">
        <div className="flex items-center gap-2">
          <span className="font-semibold uppercase tracking-wide">Console</span>
          <span>&middot;</span>
          <span>{state.tracks.length} tracks</span>
          <span>&middot;</span>
          <span>{state.busses.length} busses</span>
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-default/20 bg-surface/40 p-0.5">
          <button
            type="button"
            onClick={() => handleDensityChange("narrow")}
            className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
              density === "narrow"
                ? "bg-accent/20 text-accent font-bold shadow-sm"
                : "text-foreground/50 hover:text-foreground"
            }`}
          >
            Narrow (64px)
          </button>
          <button
            type="button"
            onClick={() => handleDensityChange("standard")}
            className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
              density === "standard"
                ? "bg-accent/20 text-accent font-bold shadow-sm"
                : "text-foreground/50 hover:text-foreground"
            }`}
          >
            Standard (96px)
          </button>
          <button
            type="button"
            onClick={() => handleDensityChange("wide")}
            className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
              density === "wide"
                ? "bg-accent/20 text-accent font-bold shadow-sm"
                : "text-foreground/50 hover:text-foreground"
            }`}
          >
            Wide (128px)
          </button>
        </div>
      </div>

      <div
        className={`flex min-h-0 flex-1 rounded-xl border border-default/30 bg-background p-1.5 sm:p-3 ${
          compact ? "overflow-x-auto" : "overflow-hidden"
        }`}
      >
        {state.tracks.length === 0 && state.busses.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center px-4 py-6 text-center text-sm text-foreground/40">
            No tracks staged in this project.
          </div>
        ) : (
          <>
            <ConsolePane
              compact={compact}
              className={`flex min-h-0 pr-1 ${compact ? "shrink-0" : "flex-1"}`}
            >
              {/* Spacers stand in for the strips that are not mounted, so the
                  scroll extent and every strip's position are unchanged.
                  The leading one also carries the ref: it is the row's first
                  child, so its left edge IS the row's left edge, which is the
                  offset the window is computed from. */}
              <div
                ref={trackWindow.contentRef}
                className="h-full shrink-0"
                style={{ width: trackWindow.window.padStartPx }}
                aria-hidden
              />
              {state.tracks
                .slice(trackWindow.window.start, trackWindow.window.end)
                .map((t, offset) => {
                  const i = trackWindow.window.start + offset;
                  return (
                    <div
                      key={t.id}
                      className="mr-2 flex h-full min-h-0 shrink-0"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({
                          kind: "track",
                          x: e.clientX,
                          y: e.clientY,
                          index: i,
                          track: t,
                          songIndex,
                        });
                      }}
                    >
                      <TrackStrip
                        t={t}
                        index={i}
                        destinationBusses={destinationBusses}
                        allBusses={state.busses}
                        auxBusses={auxBusses}
                        meters={state.meters}
                        settings={state.settings}
                        anySoloInGroup={anyTrackSolo}
                        pluginCatalog={effectCatalog}
                        isRecording={state.recording ?? false}
                        density={density}
                        targetPluginSlots={maxPluginSlots}
                        onDirectOutput={requestTrackDirectOutput}
                        onOpenPlugins={openPlugins}
                      />
                    </div>
                  );
                })}
              <div
                className="h-full shrink-0"
                style={{ width: trackWindow.window.padEndPx }}
                aria-hidden
              />
            </ConsolePane>

            <div className="mx-2 w-px shrink-0 self-stretch bg-default/40" />

            <ConsolePane
              compact={compact}
              className={`flex shrink-0 ${compact ? "" : "max-w-[35%]"}`}
            >
              <div className={`mr-2 flex h-full ${density === "narrow" ? "w-16" : density === "wide" ? "w-28" : "w-20"} shrink-0 flex-col items-center justify-center`}>
                {/* Dashed and full-height on purpose -- it stands where a
                    strip would, so it reads as a slot to fill rather than as
                    a control in the row. */}
                <Button
                  variant="default-soft"
                  aria-label="Add a new return/send bus"
                  onPress={() => requestAddSend()}
                  className={`h-full ${density === "narrow" ? "w-16" : density === "wide" ? "w-28" : "w-20"} shrink-0 flex-col bg-background-secondary hover:bg-background-tertiary/50 transition-all gap-0 rounded-xl border border-dashed border-default/40 text-foreground/60`}
                >
                  <Plus size={22} />
                  <span className="text-[11px] font-semibold">Send</span>
                </Button>
              </div>

              {/* See the track pane above for what the spacers are doing. */}
              <div
                ref={sendWindow.contentRef}
                className="h-full shrink-0"
                style={{ width: sendWindow.window.padStartPx }}
                aria-hidden
              />
              {auxBusses
                .slice(sendWindow.window.start, sendWindow.window.end)
                .map((b) => (
                  <div
                    key={b.id}
                    className="mr-2 flex h-full min-h-0 shrink-0"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({
                        kind: "send",
                        x: e.clientX,
                        y: e.clientY,
                        index: state.busses.indexOf(b),
                        bus: b,
                      });
                    }}
                  >
                    <BusStrip
                      b={b}
                      index={state.busses.indexOf(b)}
                      meters={state.meters}
                      master={master}
                      settings={state.settings}
                      anySoloInGroup={anyAuxSolo}
                      pluginCatalog={effectCatalog}
                      density={density}
                      targetPluginSlots={maxPluginSlots}
                      onOpenPlugins={openPlugins}
                    />
                  </div>
                ))}
              <div
                className="h-full shrink-0"
                style={{ width: sendWindow.window.padEndPx }}
                aria-hidden
              />
            </ConsolePane>

            <div className="mx-2 w-px shrink-0 self-stretch bg-default/40" />

            <div className="flex h-full min-h-0 shrink-0 gap-2 items-stretch">
              <div
                className="flex h-full min-h-0 shrink-0"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    kind: "click",
                    x: e.clientX,
                    y: e.clientY,
                    name: state.click?.name?.trim() || "Click",
                    onRename: (name) =>
                      patchClickFields(state, { clickName: name }),
                    onResetGainPan: () =>
                      patchClickFields(state, {
                        clickGainDb: 0,
                        clickPan: 0,
                      }),
                    onClearMuteSolo: () => {
                      patchClickFields(state, { click: true });
                      void mixer.setClickSolo(false);
                    },
                    hasSends: clickSends.length > 0,
                    onRemoveAllSends: () =>
                      patchClickFields(state, { clickSends: [] }),
                  });
                }}
              >
                <MetronomeStrip
                  state={state}
                  density={density}
                  targetPluginSlots={maxPluginSlots}
                  onDirectOutput={requestClickDirectOutput}
                  onOpenPlugins={openPlugins}
                  pluginCatalog={effectCatalog}
                />
              </div>

              <div className="mx-1 w-px shrink-0 self-stretch bg-default/40" />

              {masterBusses.map((b) => (
                <div
                  key={b.id}
                  className="flex h-full min-h-0 shrink-0"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      kind: "master",
                      x: e.clientX,
                      y: e.clientY,
                      index: state.busses.indexOf(b),
                      bus: b,
                    });
                  }}
                >
                  <BusStrip
                    b={b}
                    index={state.busses.indexOf(b)}
                    meters={state.meters}
                    master={master}
                    settings={state.settings}
                    anySoloInGroup={b.soloActiveInGroup}
                    isMaster
                    pluginCatalog={effectCatalog}
                    density={density}
                    targetPluginSlots={maxPluginSlots}
                    onOpenPlugins={openPlugins}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {menu && (
        <StripContextMenu
          target={menu}
          onRender={onRender}
          onClose={() => setMenu(null)}
        />
      )}
      {pluginTarget && (
        <PluginChainModal
          open
          stripId={pluginTarget.stripId}
          stripName={pluginTarget.stripName}
          slots={
            pluginTarget.stripId === "audio::click"
              ? (state.click?.plugins ?? [])
              : (state.tracks.find((track) => track.id === pluginTarget.stripId)
                  ?.plugins ??
                state.busses.find((bus) => bus.id === pluginTarget.stripId)
                  ?.plugins ??
                [])
          }
          onClose={() => setPluginTarget(null)}
        />
      )}
    </div>
  );
}
