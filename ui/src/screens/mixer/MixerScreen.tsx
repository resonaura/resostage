import { ScrollShadow } from "@heroui/react";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { builder, mixer } from "../../lib/api";
import type { WebUiState } from "../../lib/types";
import { BusStrip } from "./BusStrip";
import { MetronomeStrip, patchClickFields } from "./MetronomeStrip";
import { StripContextMenu, type StripMenuTarget } from "./StripContextMenu";
import { TrackStrip } from "./TrackStrip";

interface PendingBusJob {
  knownIds: Set<string>;
  finalize: (busId: string, index: number) => void;
}

export function MixerScreen({ state }: { state: WebUiState }) {
  const auxBusses = state.busses.filter((b) => b.isAux);
  const master =
    state.busses.find((b) => b.id === "main") ??
    state.busses.find((b) => !b.isAux);
  const masterBusses = master ? [master] : [];
  // Track destination list: master + aux only (no hidden Ext. Out sub-buses).
  // Aux → aux is never offered as a main destination here; track sends only
  // target aux via SendKnobs (no send→send loop).
  const destinationBusses = state.busses.filter(
    (b) => b.id === "main" || b.isAux,
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

  function nextOutputChannel(): number {
    return state.busses.reduce(
      (max, b) => Math.max(max, b.startChannel + b.channels),
      0,
    );
  }

  function requestAddSend() {
    const label = `Send ${auxBusses.length + 1}`;
    const freeStart = nextOutputChannel();
    const hwCount = state.settings.outputChannelNames?.length ?? 2;
    const startChannel =
      freeStart + 2 <= hwCount ? freeStart : (master?.startChannel ?? 0);
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
   * Shared Ext. Out target: reuse a *hidden* non-main non-aux bus on that
   * hardware start, else create one. Never reuse `main` — assigning Main as
   * the Ext. Out target made the primary select snap back to "Main" (and
   * flicker on the metronome) even though the user picked Ext. Out.
   * Hidden buses stay off the mixer rail / destination list.
   */
  function ensureDirectOutBus(
    startChannel: number,
    pair: boolean,
    onReady: (busId: string) => void,
  ) {
    const channels = pair ? 2 : 1;
    const existing = state.busses.find(
      (b) =>
        !b.isAux &&
        b.id !== "main" &&
        b.startChannel === startChannel &&
        (pair ? b.channels >= 2 : b.channels === 1),
    );
    if (existing) {
      if (
        existing.startChannel !== startChannel ||
        existing.channels !== channels
      ) {
        const idx = state.busses.indexOf(existing);
        if (idx >= 0) {
          void builder.busUpdate({
            index: idx,
            name: existing.name,
            channels,
            startChannel,
            gainDb: existing.gainDb,
            pan: existing.pan,
            mute: existing.mute,
            solo: existing.solo,
            isAux: false,
          });
        }
      }
      onReady(existing.id);
      return;
    }
    const label = pair
      ? `Out ${startChannel + 1}/${startChannel + 2}`
      : `Out ${startChannel + 1}`;
    queueBusJob((busId, index) => {
      void builder.busUpdate({
        index,
        name: label,
        channels,
        startChannel,
        gainDb: 0,
        mute: false,
        solo: false,
        isAux: false,
      });
      onReady(busId);
    });
  }

  function requestTrackDirectOutput(
    trackIndex: number,
    _mono: boolean,
    startChannel: number,
    pair: boolean,
  ) {
    ensureDirectOutBus(startChannel, pair, (busId) => {
      void mixer.setTrackBus(trackIndex, busId);
    });
  }

  function requestClickDirectOutput(startChannel: number, pair: boolean) {
    ensureDirectOutBus(startChannel, pair, (busId) => {
      // Always patch against latest state — bus create is async and a
      // closed-over `state` would stomp concurrent click edits / show a
      // stale busId until the next WS tick (visible select flicker).
      patchClickFields(stateRef.current, { clickBusId: busId });
    });
  }

  const anyTrackSolo =
    (state.clickSolo ?? false) || state.tracks.some((tr) => tr.solo);
  const anyAuxSolo = auxBusses.some((b) => b.solo);
  const songIndex = state.songIndex >= 0 ? state.songIndex : 0;
  const clickSends = state.clickSends ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 text-xs text-foreground/40">
        <span className="font-semibold uppercase tracking-wide">Console</span>
        <span>&middot;</span>
        <span>{state.tracks.length} tracks</span>
        <span>&middot;</span>
        <span>{state.busses.length} busses</span>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-default/30 bg-background p-3">
        {state.tracks.length === 0 && state.busses.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center px-4 py-6 text-center text-sm text-foreground/40">
            No tracks staged in this project.
          </div>
        ) : (
          <>
            <ScrollShadow
              orientation="horizontal"
              className="flex min-h-0 flex-1 gap-2 pr-1"
            >
              {state.tracks.map((t, i) => (
                <div
                  key={t.id}
                  className="flex h-full min-h-0 shrink-0"
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
              ))}
            </ScrollShadow>

            <div className="mx-2 w-px shrink-0 self-stretch bg-default/40" />

            <ScrollShadow
              orientation="horizontal"
              className="flex shrink-0 gap-2 max-w-[35%]"
            >
              <div className="flex h-full w-20 shrink-0 flex-col items-center justify-center">
                <button
                  onClick={() => requestAddSend()}
                  title="Add a new return/send bus"
                  className="flex h-full w-20 shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-default/40 bg-default/10 text-foreground/60 transition-colors hover:bg-default/25 hover:text-foreground"
                >
                  <Plus size={22} />
                  <span className="text-[11px] font-semibold">Send</span>
                </button>
              </div>

              {auxBusses.map((b) => (
                <div
                  key={b.id}
                  className="flex h-full min-h-0 shrink-0"
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
            </ScrollShadow>

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
                    name: state.clickName?.trim() || "Click",
                    onRename: (name) =>
                      patchClickFields(state, { clickName: name }),
                    onResetGainPan: () =>
                      patchClickFields(state, {
                        clickGainDb: -6,
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
