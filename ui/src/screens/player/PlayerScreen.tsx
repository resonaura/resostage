import { Popover, Tooltip } from "@heroui/react";
import {
  ChevronDown,
  Circle,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  formatClockPrecise as formatTime,
  LiveReadout,
} from "../../components/daw";
import { FontIcon } from "../../components/common/FontIcon";
import { Timeline } from "../editor/timeline";
import { useSongLayout } from "../editor/timeline/layout/hooks/useSongLayout";
import {
  Button,
  ButtonGroup,
  Card,
  ToggleButton,
  ToggleButtonGroup,
} from "../../components/ui";
import { builder, transport } from "../../lib/state/api";
import { useContinuousPlayhead } from "../../lib/state/optimistic";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type AllPeaksResponse,
  type ClickSendRow,
  type LightFixtureRow,
  type PeaksResponse,
  type WebUiState,
} from "../../lib/state/types";
import { useIsCompact } from "../../hooks/useMediaQuery";
import { CountInControl } from "../../transport/components/CountInControl";
import { SystemHealthWidget } from "./components/SystemHealthWidget";
import { BusMetersPanel } from "./components/BusMetersPanel";
import { SetlistPanel } from "./components/SetlistPanel";
import { barBeat, globalBarBeat } from "./logic/timeDisplay";
import { DriftReadout } from "./components/DriftReadout";
import { PlayerLightStagePreview } from "./components/PlayerLightStagePreview";

/** Stable empty roster so a rig with no fixtures doesn't churn the memo. */
const EMPTY_FIXTURES: LightFixtureRow[] = [];


export function PlayerScreen({
  state,
  cpuHistory,
  ramHistory,
  peaks,
  allPeaks,
  pxPerSec,
  setPxPerSec,
}: {
  state: WebUiState;
  cpuHistory: number[];
  ramHistory: number[];
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
}) {
  const compact = useIsCompact();
  const [metronomeOverride, setMetronomeOverride] = useState<boolean | null>(
    null,
  );
  const [clickSendsOpen, setClickSendsOpen] = useState(false);
  // Anchors the routing popover; see the note at its trigger.
  const clickRoutingAnchorRef = useRef<HTMLDivElement>(null);
  // Optimistic setlist highlight: flip immediately on click so hopscotch
  // never waits for the ~30 Hz WS round-trip / stageSong to paint.
  const [optimisticSongIndex, setOptimisticSongIndex] = useState<number | null>(
    null,
  );
  useEffect(() => {
    if (
      optimisticSongIndex != null &&
      state.songIndex === optimisticSongIndex
    ) {
      setOptimisticSongIndex(null);
    }
  }, [state.songIndex, optimisticSongIndex]);
  const displaySongIndex =
    optimisticSongIndex != null ? optimisticSongIndex : state.songIndex;
  // Stable identity so the memoized setlist isn't invalidated every frame by
  // a freshly-allocated click handler.
  const selectSong = useCallback((i: number) => {
    setOptimisticSongIndex(i);
    void transport.select(i);
  }, []);

  const hasSongs = state.songs.length > 0;
  // Project-global metronome (not per-song). Optimistic override until
  // state.click catches up from the WS snapshot.
  const isMetronomeOn = metronomeOverride ?? state.click?.enabled ?? false;
  useEffect(() => {
    if (metronomeOverride != null && state.click?.enabled === metronomeOverride)
      setMetronomeOverride(null);
  }, [state.click?.enabled, metronomeOverride]);

  const patchProjectClick = (partial: {
    click?: boolean;
    clickBusId?: string;
    clickSends?: ClickSendRow[];
  }) => {
    const idx = hasSongs ? (state.songIndex >= 0 ? state.songIndex : 0) : -1;
    const s = hasSongs ? state.songs[idx] : null;
    void builder.songUpdate({
      index: idx,
      name: s?.name ?? "",
      bpm: s?.bpm ?? 120,
      mode: s?.mode ?? "wait",
      tsNum: s?.tsNum ?? 4,
      tsDen: s?.tsDen ?? 4,
      click: partial.click ?? state.click?.enabled ?? false,
      // Preserve empty clickBusId (Sends Only) — never coerce "" → main.
      clickBusId:
        partial.clickBusId !== undefined
          ? partial.clickBusId
          : state.click
            ? sourceOutputBusId(state.click.output)
            : (s?.clickBusId ?? ""),
      clickSends: (
        partial.clickSends ??
        (state.click
          ? outputSendsToClickRows(state.click.output)
          : undefined) ??
        s?.clickSends ??
        []
      ).map((cs) => ({
        busId: cs.busId,
        level: cs.level,
        enabled: cs.enabled,
      })),
    });
  };

  const toggleMetronome = () => {
    const nextState = !isMetronomeOn;
    setMetronomeOverride(nextState);
    patchProjectClick({ click: nextState });
  };

  // Toggle a send on/off for the metronome (aux bus click routing)
  const toggleClickSend = (busId: string) => {
    const clickSends = state.click
      ? outputSendsToClickRows(state.click.output)
      : [];
    const existing = clickSends.find((cs) => cs.busId === busId);
    let newSends: ClickSendRow[];
    if (existing) {
      newSends = clickSends.map((cs) =>
        cs.busId === busId ? { ...cs, enabled: !cs.enabled } : cs,
      );
    } else {
      newSends = [...clickSends, { busId, level: 100, enabled: true }];
    }
    patchProjectClick({ clickSends: newSends });
  };

  // ONE continuous absolute clock for transport. Song-local is derived from
  // the current song's offset so gapless boundaries don't reset a second clock.
  //
  // Deliberately NOT mirrored into React state (the trailing `false`): the
  // only things that read this clock are the four readouts below, and each
  // paints itself off the shared frame driver. Mirroring it re-rendered the
  // entire Player -- setlist, meter bay, light preview, transport -- sixty
  // times a second to move a handful of digits. Timeline already reads its
  // playhead this way; see useContinuousPlayhead's `publishToReact`.
  const [, , getLiveAbsolute] = useContinuousPlayhead(
    state.globalPlayheadSeconds,
    state.playing,
    state.projectName,
    false,
    undefined,
    undefined,
    false,
  );

  const song =
    state.songIndex >= 0 && state.songs[state.songIndex]
      ? state.songs[state.songIndex]
      : null;

  // The same layout the timeline lays out from, not a second opinion.
  //
  // This screen used to derive song length itself, from the longest region
  // DURATION -- which is not a length: it ignored where the region starts, so
  // anything not butted up against zero came out short, and it ignored
  // SongDef::endSeconds entirely, so a song stretched by hand still counted
  // to wherever its audio happened to stop. Two screens showing two different
  // ends of the same song, with the timeline's the correct one.
  const { songLengths, songOffsets } = useSongLayout(
    state.songs,
    allPeaks,
    peaks,
    state.songIndex,
  );
  const songIdx = state.songIndex >= 0 ? state.songIndex : 0;
  const songOffset = songOffsets[songIdx] ?? 0;
  const songLength = state.songs.length > 0 ? (songLengths[songIdx] ?? 0) : 0;
  // Song-local = absolute − offset of current song (one timeline, not two).
  // A live read, not a rendered value -- see the clock above.
  const liveSongSeconds = () => Math.max(0, getLiveAbsolute() - songOffset);

  // Empty string = Sends Only (must not fall back to main via falsy ||).
  const currentClickBus = state.click
    ? sourceOutputBusId(state.click.output)
    : "";
  const auxBusses = state.busses.filter((b) => b.isAux);
  const enabledClickSendIds = (
    state.click ? outputSendsToClickRows(state.click.output) : []
  )
    .filter((cs) => cs.enabled)
    .map((cs) => cs.busId);

  const changeClickBus = (busId: string) => {
    // busId may be "" for Sends Only. Project-global.
    patchProjectClick({ clickBusId: busId });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto sm:gap-3 sm:overflow-visible">
      {/* ── 1. Top Transport bar ──────────────────────────────── */}
      {/* Stacks on phones: the desktop row is one ~900px-wide line of clock,
          title, transport and health graphs that cannot usefully shrink. */}
      <Card className="flex shrink-0 flex-col items-stretch gap-0 overflow-hidden sm:flex-row p-0">
        {/* Clock + bar/beat + abs (full info — header has compact clock) */}
        <div className="flex shrink-0 flex-col justify-center border-b border-default/30 px-4 py-2 sm:border-b-0 sm:border-r sm:px-5 sm:py-2.5">
          <div
            style={{ fontWeight: "100" }}
            className={`font-mono text-2xl tabular-nums tracking-tight leading-none sm:text-3xl ${
              state.playing ? "text-accent" : "text-foreground"
            }`}
          >
            {/* The clock runs at the full frame rate; the readouts below it
                are coarser on purpose -- a bar/beat that only changes a few
                times a second does not need sampling sixty. */}
            <LiveReadout
              sample={() => formatTime(liveSongSeconds())}
              intervalMs={0}
            />
            {songLength > 0 && (
              <span className="ml-2 text-sm font-normal text-foreground/25">
                / {formatTime(songLength)}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <LiveReadout
              className="font-mono text-base font-semibold tabular-nums text-accent"
              // Per frame. The default 12/s throttle is right for a clock,
              // whose last digit is a blur either way, and wrong for this:
              // bar|beat changes once a beat and the whole value of it is
              // landing on that beat, not up to 83ms after it.
              intervalMs={0}
              sample={() =>
                song ? barBeat(liveSongSeconds(), song.bpm, song.tsNum) : "—"
              }
            />
            <span className="text-[11px] text-foreground/30">bar | beat</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5 opacity-60">
            <LiveReadout
              className="font-mono text-[10px] tabular-nums text-foreground/35"
              sample={() => formatTime(getLiveAbsolute())}
            />
            <LiveReadout
              className="font-mono text-[10px] tabular-nums text-foreground/35"
              intervalMs={0}
              sample={() =>
                song
                  ? globalBarBeat(
                      state.globalBeatsElapsed +
                        Math.max(
                          0,
                          getLiveAbsolute() - state.globalPlayheadSeconds,
                        ) *
                          ((song.bpm > 0 ? song.bpm : 120) / 60),
                      song.tsNum,
                    )
                  : "—"
              }
            />
            <span className="text-[9px] text-foreground/25">abs</span>
          </div>
        </div>

        {/* Song metadata — flex-1 so the card fills evenly (clock + transport
            + health stay fixed; title/BPM claim the leftover width). */}
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center border-b border-default/30 px-4 py-2 text-center sm:border-b-0 sm:border-r sm:py-2.5">
          <div className="w-full max-w-full truncate text-sm font-semibold">
            {state.songName || "No song selected"}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[11px] text-foreground/40">
            {song && song.bpm > 0 ? (
              <>
                <span className="font-mono tabular-nums text-accent">
                  {song.bpm.toFixed(1)} BPM
                </span>
                <span>
                  {song.tsNum}/{song.tsDen}
                </span>
                <span>{state.tracks.length} tracks</span>
              </>
            ) : (
              <span>Select a song to begin</span>
            )}
            <DriftReadout drift={state.drift} />
          </div>
        </div>

        {/* Transport control buttons */}
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-3 py-2.5">
          {/* `size` is repeated on every button rather than left to the group.
              ButtonGroup shares it by marking its DIRECT children, and these
              are wrapped in Tooltip -- so the mark lands on the tooltip and the
              buttons inside fall back to the default size, which is what made
              Play stand a notch taller than the icons beside it. (The group's
              own rounding still works: Tooltip renders no wrapper element, so
              the buttons remain its first and last DOM children.) */}
          <ButtonGroup aria-label="Transport">
            <Tooltip>
              <Button
                size="sm"
                isIconOnly
                variant="default-soft"
                onPress={() => transport.prev()}
                aria-label="Previous"
              >
                <SkipBack size={16} />
              </Button>
              <Tooltip.Content>Previous</Tooltip.Content>
            </Tooltip>
            <Button
              size="sm"
              variant={state.playing ? "accent-soft" : "default-soft"}
              onPress={() =>
                state.playing ? transport.stop() : transport.play()
              }
              aria-label={state.playing ? "Pause" : "Play"}
            >
              <ButtonGroup.Separator />
              {state.playing ? <Pause size={15} /> : <Play size={15} />}
            </Button>
            <Tooltip>
              <Button
                size="sm"
                isIconOnly
                variant="danger-soft"
                onPress={() => void transport.stopToStart()}
                aria-label="Stop"
              >
                <ButtonGroup.Separator />
                <Square size={16} />
              </Button>
              <Tooltip.Content>
                Stop — press again at song start to jump to project start
              </Tooltip.Content>
            </Tooltip>
            <Tooltip>
              <Button
                size="sm"
                isIconOnly
                variant={state.recording ? "danger" : "default-soft"}
                className={
                  state.recording
                    ? "text-danger animate-pulse font-bold"
                    : "text-foreground/70 hover:text-danger"
                }
                onPress={() => void transport.record()}
                aria-label={state.recording ? "Stop Recording" : "Record"}
              >
                <ButtonGroup.Separator />
                <Circle
                  size={14}
                  className={state.recording ? "fill-danger" : "fill-current"}
                />
              </Button>
              <Tooltip.Content>
                {state.recording ? "Stop Recording" : "Record (Audio & MIDI)"}
              </Tooltip.Content>
            </Tooltip>
            <Tooltip>
              <Button
                size="sm"
                isIconOnly
                variant="default-soft"
                onPress={() => transport.next()}
                aria-label="Next"
              >
                <ButtonGroup.Separator />
                <SkipForward size={16} />
              </Button>
              <Tooltip.Content>Next</Tooltip.Content>
            </Tooltip>
          </ButtonGroup>

          {/* Global metronome + its send routing. Two unrelated booleans, hence
              a multiple-selection group rather than an exclusive one: the click
              can be on with the routing panel shut, and vice versa.

              The routing panel is a real Popover: it renders in an overlay
              portal, so it is no longer clipped away by the transport card's
              own `overflow-hidden` (which is what kept it invisible), and it
              closes on an outside click or Escape instead of only on a second
              press of the chevron. `triggerRef` anchors it to the group --
              HeroUI's Popover normally takes its anchor from a Button child,
              and a ToggleButton is a different primitive that never registers
              itself as one. */}
          <Popover isOpen={clickSendsOpen} onOpenChange={setClickSendsOpen}>
            <div ref={clickRoutingAnchorRef}>
              <ToggleButtonGroup
                aria-label="Metronome"
                size="sm"
                selectionMode="multiple"
                selectedKeys={[
                  ...(isMetronomeOn ? ["on"] : []),
                  ...(clickSendsOpen ? ["routing"] : []),
                ]}
                onSelectionChange={(keys) => {
                  const next = new Set(Array.from(keys, String));
                  if (next.has("on") !== isMetronomeOn) toggleMetronome();
                  setClickSendsOpen(next.has("routing"));
                }}
              >
                <ToggleButton id="on">
                  <FontIcon name="metronome" size={16} />
                  <span>Click</span>
                </ToggleButton>
                <Tooltip>
                  <ToggleButton
                    id="routing"
                    isIconOnly
                    aria-label="Click send routing"
                  >
                    <ToggleButtonGroup.Separator />
                    <ChevronDown
                      size={12}
                      className={`transition-transform ${clickSendsOpen ? "rotate-180" : ""}`}
                    />
                  </ToggleButton>
                  <Tooltip.Content>Click send routing</Tooltip.Content>
                </Tooltip>
              </ToggleButtonGroup>
            </div>
            {/* 1-to-1 track parity with Output Bus select + Aux Sends list */}
            <Popover.Content
              triggerRef={clickRoutingAnchorRef}
              placement="bottom end"
              className="w-64"
            >
              <Popover.Dialog className="space-y-3 select-none">
                <div className="flex items-center justify-between border-b border-default/20 pb-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-foreground/50">
                    Click Routing
                  </span>
                  <span className="text-[10px] font-mono text-accent">
                    Metronome
                  </span>
                </div>

                {/* Primary Destination Bus Select (1-to-1 like track output) */}
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-foreground/60">
                    Output Bus
                  </label>
                  <select
                    value={
                      currentClickBus === ""
                        ? "__sends_only__"
                        : currentClickBus
                    }
                    onChange={(e) =>
                      changeClickBus(
                        e.target.value === "__sends_only__"
                          ? ""
                          : e.target.value,
                      )
                    }
                    className="w-full rounded-md border border-default/40 bg-default/20 px-2 py-1 text-xs text-foreground focus:outline-none"
                  >
                    {state.busses.map((bus) => (
                      <option key={bus.id} value={bus.id}>
                        {bus.name || bus.id}
                      </option>
                    ))}
                    <option value="__sends_only__">Sends Only</option>
                  </select>
                </div>

                {/* Aux Sends List (1-to-1 like track sends) */}
                <div className="space-y-1.5">
                  <div className="text-[10px] font-semibold text-foreground/60">
                    Aux Sends
                  </div>
                  {auxBusses.length === 0 ? (
                    <div className="text-[10px] text-foreground/30 py-1">
                      No Aux buses
                    </div>
                  ) : (
                    /* Independent on/off per bus -- a multiple-selection group,
                       detached so each send reads as its own row rather than a
                       segment of one bar. */
                    <ToggleButtonGroup
                      aria-label="Aux sends"
                      orientation="vertical"
                      isDetached
                      fullWidth
                      size="sm"
                      selectionMode="multiple"
                      selectedKeys={enabledClickSendIds}
                      onSelectionChange={(keys) => {
                        const next = new Set(Array.from(keys, String));
                        for (const bus of auxBusses) {
                          if (
                            next.has(bus.id) !==
                            enabledClickSendIds.includes(bus.id)
                          )
                            toggleClickSend(bus.id);
                        }
                      }}
                    >
                      {auxBusses.map((bus) => (
                        <ToggleButton key={bus.id} id={bus.id}>
                          <span className="truncate">{bus.name || bus.id}</span>
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                  )}
                </div>
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
          <CountInControl state={state} />
          {state.recordingCountIn && (
            <span
              role="status"
              aria-live="polite"
              aria-label={`Count-in: ${state.recordingCountInBeatsRemaining ?? 0} beats remaining`}
              className="flex h-9 min-w-10 items-center justify-center rounded-md bg-(--rs-record)/15 px-2 font-mono text-(--rs-record)"
            >
              <strong key={state.recordingCountInBeatsRemaining} className="rs-count-in-beat text-2xl tabular-nums">
                {((Math.max(1, state.recordingCountInBeatsRemaining ?? 1) - 1) % Math.max(1, song?.tsNum ?? 4)) + 1}
              </strong>
            </span>
          )}
        </div>

        {/* Dual sparkline graphs: CPU & RAM */}
        <SystemHealthWidget
          health={state.health}
          playing={state.playing}
          cpuHistory={cpuHistory}
          ramHistory={ramHistory}
        />
      </Card>

      {/* ── 2. Middle: Setlist + Bus meters (flex layout, max 40% meters width) ─ */}
      <div className="flex shrink-0 flex-col gap-2 sm:h-52.5 sm:flex-row sm:gap-3">
        <SetlistPanel
          songs={state.songs}
          activeIndex={displaySongIndex}
          playing={state.playing}
          onSelect={selectSong}
        />

        <PlayerLightStagePreview
          fixtures={state.lighting?.fixtures ?? EMPTY_FIXTURES}
          enabled={Boolean(state.lighting?.enabled)}
        />

        <BusMetersPanel
          meters={state.meters}
          busses={state.busses}
          tracks={state.tracks}
          click={state.click}
        />
      </div>

      {/* ── 3. Bottom: Timeline (expands to fill remaining height) ──
          Deliberately NOT rendered on phones: a multi-song arrangement with
          per-region waveform canvases is neither usable at that width nor
          affordable on that hardware, and `display: none` would still build
          and animate all of it. */}
      {!compact && (
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <Timeline
            state={state}
            peaks={peaks}
            allPeaks={allPeaks}
            pxPerSec={pxPerSec}
            setPxPerSec={setPxPerSec}
            readOnly
          />
        </Card>
      )}
    </div>
  );
}
