import { ScrollShadow } from "@heroui/react";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui";
import { useHorizontalWindow } from "../../hooks/useHorizontalWindow";
import { builder, mixer } from "../../lib/api";
import { outputSendsToClickRows, type WebUiState } from "../../lib/types";
import { useIsCompact } from "../../lib/useMediaQuery";
import { BusStrip } from "./BusStrip";
import { MetronomeStrip } from "./MetronomeStrip";
import { extOutTarget, isMainBusId } from "./mixerIds";
import { patchClickFields } from "./mixerUtils";
import { StripContextMenu, type StripMenuTarget } from "./StripContextMenu";
import { TrackStrip } from "./TrackStrip";

interface PendingBusJob {
  knownIds: Set<string>;
  finalize: (busId: string, index: number) => void;
}

/**
 * One strip's footprint: the 96px strip (ChannelStrip's `w-24`) plus the 8px
 * that separates it from the next. The virtualised panes carry that gap as a
 * right margin on each item rather than as the flex `gap-2` the other panes
 * use, so a spacer standing in for N strips is exactly N * this and the
 * scrollbar is the same length virtualised or not.
 */
const STRIP_PITCH_PX = 104;

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
    <ScrollShadow orientation="horizontal" className={className}>
      {children}
    </ScrollShadow>
  );
}

export function MixerScreen({ state }: { state: WebUiState }) {
  const compact = useIsCompact();
  const auxBusses = state.busses.filter((b) => b.isAux);
  const trackWindow = useHorizontalWindow({
    count: state.tracks.length,
    pitchPx: STRIP_PITCH_PX,
    enabled: state.tracks.length >= VIRTUALIZE_FROM,
  });
  const sendWindow = useHorizontalWindow({
    count: auxBusses.length,
    pitchPx: STRIP_PITCH_PX,
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 text-xs text-foreground/40">
        <span className="font-semibold uppercase tracking-wide">Console</span>
        <span>&middot;</span>
        <span>{state.tracks.length} tracks</span>
        <span>&middot;</span>
        <span>{state.busses.length} busses</span>
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
                        onDirectOutput={requestTrackDirectOutput}
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
              <div className="mr-2 flex h-full w-20 shrink-0 flex-col items-center justify-center">
                {/* Dashed and full-height on purpose -- it stands where a
                    strip would, so it reads as a slot to fill rather than as
                    a control in the row. */}
                <Button
                  variant="default-soft"
                  aria-label="Add a new return/send bus"
                  onPress={() => requestAddSend()}
                  className="h-full w-20 shrink-0 flex-col bg-background-secondary hover:bg-background-tertiary/50 transition-all gap-0 rounded-xl border border-dashed border-default/40 text-foreground/60"
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
                  onDirectOutput={requestClickDirectOutput}
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
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {menu && <StripContextMenu target={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
