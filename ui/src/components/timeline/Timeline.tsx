import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { builder } from "../../lib/state/api";
import {
  useContinuousPlayhead,
  type CycleWrapRange,
} from "../../lib/state/optimistic";
import { useThemeVersion } from "../../hooks/useThemeVersion";
import { addRafTask } from "../../lib/state/rafLoop";
import { useScrollShadow } from "@heroui/react";
import { isPositionVisible } from "../../lib/timeline/timelineVisibility";
import { useTimelineFileDrop } from "./drop/hooks/useTimelineFileDrop";
import { hasClipboard } from "./selection/logic/timelineClipboard";
import { useTimelineGestureActivity } from "./viewport/hooks/useTimelineGestureActivity";
import { RegionSidePanel } from "./regions/components/RegionSidePanel";
import {
  quantizeScrollWindow,
  sameScrollWindow,
  type ScrollWindow,
} from "./layout/logic/scrollWindow";
import type {
  AllPeaksResponse,
  PeaksResponse,
  WebUiState,
} from "../../lib/state/types";
import { getLightColor } from "../light/lightColors";
import { LightSidePanel } from "../light/LightSidePanel";
import type { CueSelKey, LightCueDragState } from "../light/LightTimeline";
import {
  AUDIO_HINT_HEIGHT,
  AudioHintStrip,
  LIGHT_HINT_HEIGHT,
  LightHintStrip,
} from "../light/LightTimeline";
import {
  emptyProjectActions,
  EmptyProjectState,
} from "../project/EmptyProjectState";
import { AudioDropGhost } from "./drop/components/AudioDropGhost";
import { AudioTrackLanes } from "./tracks/components/AudioTrackLanes";
import { BeatGrid } from "./ruler/components/BeatGrid";
import {
  EVENT_LANE_HEIGHT,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  SECTION_LANE_HEIGHT,
  TRAILING_SLACK_MIN_PX,
  TRAILING_SLACK_SECONDS,
} from "./constants";
import { EventMarkerLane } from "./events/components/EventMarkerLane";
import { LongImportPrompt } from "./overrun/components/LongImportPrompt";
import { OutOfBoundsOverlay } from "./layout/components/OutOfBoundsOverlay";
import { songDetents } from "./snapping/logic/detents";
import { resolveCycleWrapRange } from "./cycle/logic/resolveCycleWrapRange";
import {
  snapSongLocalSeconds,
  timelineSecondsAtClientX,
} from "./ruler/logic/timelineCoordinates";
import { useSongEndDrag } from "./ruler/hooks/useSongEndDrag";
import { laneHeightPx } from "./layout/logic/laneDimensions";
import { LightTrackLanes } from "./tracks/components/LightTrackLanes";
import {
  RegionContextMenu,
  type RegionContextMenuState,
} from "./regions/components/RegionContextMenu";
import { splitRegionsAtPlayhead } from "./regions/logic/regionEdit";
import { resolveLightSidePanelSelection } from "./selection/logic/resolveLightSidePanelSelection";
import {
  type RegionSelKey,
  type RegionUiState,
} from "./regions/logic/regionUtils";
import { buildRows, songContentSeconds } from "./layout/logic/rows";
import { previewDropReorder } from "./tracks/logic/dropPreview";
import { SectionMarkerLane } from "./sections/components/SectionMarkerLane";
import { SelectionContextMenu } from "./selection/components/SelectionContextMenu";
import { SongRulerHeader } from "./ruler/components/SongRulerHeader";
import { TimelineSidebar } from "./tracks/components/TimelineSidebar";
import { TimelineToolbar } from "./toolbar/components/TimelineToolbar";
import { ToastContainer, type Toast } from "./toast/components/ToastContainer";
import { useCycleState } from "./cycle/hooks/useCycleState";
import { useRegionDrag } from "./regions/hooks/useRegionDrag";
import { useLongImportGuard } from "./overrun/hooks/useLongImportGuard";
import { useRegionSelectionLifecycle } from "./regions/hooks/useRegionSelectionLifecycle";
import { useSongLayout } from "./layout/hooks/useSongLayout";
import { useTimelineKeyboard } from "./selection/hooks/useTimelineKeyboard";
import { useTimelineMarquee } from "./selection/hooks/useTimelineMarquee";
import { useTimelineScrub } from "./ruler/hooks/useTimelineScrub";
import { useTimelineTrackFocus } from "./tracks/hooks/useTimelineTrackFocus";
import { useTimelineZoomGestures } from "./viewport/hooks/useTimelineZoomGestures";
import { hotkeyManager, HotkeyScope } from "../../lib/interaction/HotkeyManager";
import { useTimelinePrefs } from "./toolbar/hooks/useTimelinePrefs";
import type { TrackSelectionGesture } from "./tracks/logic/trackSelection";
import { createTimelineSelectionActions } from "./selection/logic/selectionActions";

// ------- Timeline (continuous multi-song arrangement) -------------------

/**
 * Whether the timeline paints soft fades at its horizontal edges.
 *
 * Off. It reads as the content being dimmed rather than as the view running
 * out, and on a stage anything that makes a region look muted is a question
 * the operator does not need to be asking. Left wired rather than deleted
 * because it is heading for the Appearance settings -- see the
 * useScrollShadow call, which additionally only ever runs it while the view
 * is following the playhead.
 */
const SCROLL_SHADOW_ENABLED = false;

export function Timeline({
  state,
  peaks,
  allPeaks,
  pxPerSec,
  setPxPerSec,
  readOnly = false,
  selectedTrackId,
  selectedTrackIds,
  onSelectTrackId,
  onOpenMidiRegion,
}: {
  state: WebUiState;
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
  /** Player: no track sidebar, no region trim/edit. */
  readOnly?: boolean;
  selectedTrackId?: string | null;
  selectedTrackIds?: string[];
  onSelectTrackId?: (id: string | null, gesture?: TrackSelectionGesture) => void;
  onOpenMidiRegion?: (trackId: string, regionId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const timelineBodyRef = useRef<HTMLDivElement>(null);
  // Read live (never as a render dependency) by both the follow rAF loop
  // below and useContinuousPlayhead's own reconciliation effects -- a
  // playhead drag is a direct manipulation of the transport and must
  // synchronously suspend both auto-follow AND server-value correction
  // before React has had any chance to render a state update.
  const dragging = useRef(false);
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;
  const pendingScrollLeftRef = useRef<number | null>(null);
  // Coalesces applyZoomAt's setPxPerSec commits to paint rate -- see the
  // rAF scheduling in applyZoomAt below.
  const zoomCommitRafRef = useRef(0);
  useEffect(
    () => () => {
      if (zoomCommitRafRef.current)
        cancelAnimationFrame(zoomCommitRafRef.current);
    },
    [],
  );

  // Sidebar (track header list) vertical mirror. The list sits outside the
  // right scroller, so we apply translateY(-scrollTop) imperatively from
  // onScroll (sync with the browser) + rAF as a safety net — never via
  // React state (that lagged a frame and skew-synced track labels).
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  // The COARSE window, not the live scroll position -- see layout/logic/scrollWindow.ts.
  // Everything in the tree that reads this culls or re-quantizes anyway, and
  // the follow loop writes the real scrollLeft straight to the DOM.
  const [scrollState, setScrollState] = useState<ScrollWindow>(() =>
    quantizeScrollWindow(0, 1000),
  );
  const scrollStateRef = useRef(scrollState);
  scrollStateRef.current = scrollState;

  /**
   * Publish a scroll position to React, quantized, and only when the window
   * it lands in actually changed.
   *
   * Every caller passes the live pixel position; the filtering happens here
   * so no call site has to remember to do it. This is the whole reason a
   * screen of scrolling costs a handful of commits instead of a hundred and
   * fifty -- see layout/logic/scrollWindow.ts for why the tree does not miss the
   * precision.
   */
  const commitScrollState = useCallback(
    (scrollLeft: number, viewportWidth: number) => {
      const next = quantizeScrollWindow(scrollLeft, viewportWidth);
      if (sameScrollWindow(scrollStateRef.current, next)) return;
      scrollStateRef.current = next;
      setScrollState(next);
    },
    [],
  );
  // Window listeners and the rAF loop both outlive the render that created
  // the callback; they go through this ref so they never hold a stale one.
  const commitScrollStateRef = useRef(commitScrollState);
  commitScrollStateRef.current = commitScrollState;

  // Keep this renderless state slot beside the continuous clock; the gesture
  // activity hook below owns its deduplicated updates.
  const [, setZoomActive] = useState(false);

  // ONE continuous absolute clock for the whole project. Song-local time is
  // derived below -- never a second independent rAF loop keyed on songIndex
  // (that reset/fought across gapless boundaries and felt like two timelines).
  // The clock is NOT frozen during a zoom.
  //
  // It used to be, so the marker held still against a scaling grid -- but a
  // stopped needle during a zoom is a needle showing the wrong time, and the
  // transport does not pause just because someone pinched. What genuinely
  // has to wait is the FOLLOW SCROLL, which would fight the zoom's own scroll
  // writes; that is deferred to the end of the gesture instead (see
  // pendingFollowAfterZoomRef).
  // cycleWrapRef is filled after song layout (below) each render — rAF reads
  // it live so short loops wrap on the SPA without waiting for WS.
  const cycleWrapRef = useRef<CycleWrapRange | null>(null);
  const [playheadAbsoluteSec, setPlayheadAbsoluteSec, getLivePlayheadAbsolute] =
    useContinuousPlayhead(
      state.globalPlayheadSeconds,
      state.playing,
      state.projectName,
      false, // never frozen -- see the note above
      dragging,
      cycleWrapRef,
      // Nothing this component RENDERS reads the clock -- the marker is a
      // direct style write from the frame loop below. Mirroring it into React
      // state as well re-rendered the whole arrangement every frame of every
      // song. See useContinuousPlayhead's publishToReact note.
      false,
    );
  // Live clock getter for the rAF follow/marker loop -- never go through the
  // React-state mirror (playheadAbsoluteSec), which can lag a commit behind
  // the rAF that advances the clock and made smooth-follow advance in steps.
  const getLivePlayheadAbsoluteRef = useRef(getLivePlayheadAbsolute);
  getLivePlayheadAbsoluteRef.current = getLivePlayheadAbsolute;
  /**
   * The clock as of RIGHT NOW, for the edit handlers below (paste/split at
   * playhead). They used to close over the rendered value, which is what made
   * the per-frame re-render load-bearing: with it gone, a handler that read a
   * render-time snapshot would act on wherever the playhead was at the last
   * commit rather than where it is when the user hits the key.
   */
  const playheadAbsNow = () => getLivePlayheadAbsoluteRef.current();

  const {
    followMode,
    cycleFollowMode,
    suspendFollowFromUserScroll,
    catchFollowOnPlay,
    catchFollowOnSeek,
    catchOnPlay,
    setCatchOnPlay,
    catchOnSeek,
    setCatchOnSeek,
    setViewMode,
    effectiveViewMode,
    snapToGrid,
    setSnapToGrid,
    verticalZoom,
    setVerticalZoom,
    effectiveTool,
    setTool,
    lightTrueColors,
    setLightTrueColors,
  } = useTimelinePrefs(readOnly);

  // HeroUI's own scroll-shadow detection, driving edge fades that are painted
  // as overlays rather than as its usual mask.
  //
  // The mask is what ScrollShadow normally applies to the scroller itself, and
  // this scroller cannot take one: the ruler and the playhead handle are
  // `position: sticky` inside it, and the mask fades exactly the strip they
  // live in (see the scroller's own "no transform/filter here" note). The hook
  // only writes data-*-scroll attributes, so taking it without the mask keeps
  // the part that is actually fiddly -- knowing when there is more timeline in
  // a direction, through resizes and zooms -- and leaves the paint to
  // styles/tones.css.
  //
  // Only while the view is following the playhead. With follow off the user is
  // driving the scroller by hand and knows perfectly well where the content
  // runs out; the fade is then just something dimming the region they dragged
  // to the edge. While following, the timeline moves on its own, and the fade
  // is what says "this is still going" rather than "this is the end".
  // Off for now, deliberately kept wired: this becomes a preference rather
  // than a decision, so the hook, the CSS and the follow gate all stay in
  // place and turning it on is one boolean.
  const scrollShadowActive = SCROLL_SHADOW_ENABLED && followMode !== "off";
  useScrollShadow({
    containerRef: scrollRef as React.RefObject<HTMLElement>,
    orientation: "horizontal",
    offset: 0,
    visibility: "auto",
    isEnabled: scrollShadowActive,
  });

  // Selected light cue (Light-mode editor), drives the cue editor panel.
  const [cueSelection, setCueSelection] = useState<CueSelKey | null>(null);
  // Multi-select for cues (outline + marquee / shift-click). cueSelection
  // remains the "primary" for the side panel (last clicked).
  const [selectedCueKeys, setSelectedCueKeys] = useState<CueSelKey[]>([]);

  // Track selection for the side panel
  const [sidePanelTrackIndex, setSidePanelTrackIndex] = useState<number | null>(
    null,
  );
  // Leave editing when switching away from Light mode.
  useEffect(() => {
    if (effectiveViewMode !== "light") {
      setCueSelection(null);
      setSidePanelTrackIndex(null);
    }
  }, [effectiveViewMode]);

  const {
    gestureActive,
    gestureActiveNowRef,
    pendingFollowAfterZoomRef,
    markGestureActiveRef,
    markZoomActiveRef,
    endGestureRef,
  } = useTimelineGestureActivity(setZoomActive);
  // Set right before the auto-follow effect (or the zoom-focus effect)
  // writes scroller.scrollLeft programmatically -- onScrollSync checks this
  // to tell "we just scrolled ourselves" apart from a real user drag/wheel/
  // scrollbar interaction. Native `scroll` events fire for BOTH; without
  // this, continuous "smooth" auto-follow (writing scrollLeft every frame)
  // kept re-triggering markGestureActiveRef on its own scroll events, so its
  // settle timer never got a chance to fire and gestureActive was
  // permanently stuck true during autofollow -- pinning every waveform to
  // coarse/low-detail rendering (see WaveformLane's `gestureActive` checks)
  // AND making onScrollSync's own setScrollState fight the auto-follow
  // effect's synchronous one every frame (their async native-event timing
  // vs. the effect's synchronous write don't line up), both of which read as
  // constant waveform/playhead jitter.
  // The exact horizontal value written by our follow/zoom loop.  A boolean
  // was racy: a vertical native scroll event could consume it and make a
  // later delayed horizontal echo look user-originated (or vice versa).
  const programmaticScrollLeftRef = useRef<number | null>(null);
  // Companion to programmaticScrollLeftRef for continuous "smooth" follow:
  // that loop writes scrollLeft on EVERY rAF frame, but the browser coalesces
  // native `scroll` events, so by the time one fires it can echo an OLDER
  // write that's already been superseded by several newer ones -- the exact-
  // pixel comparison above then misses (the position moved on since), and
  // onScrollSync wrongly treated ITS OWN continuous auto-scroll as a user
  // gesture, pausing autofollow for 700ms, over and over
  // ("look at this thing ... both the playhead and the timeline are jerking"). Any
  // scroll event landing shortly after ANY programmatic write is still
  // almost certainly an echo of ours, regardless of exact pixel match.
  const lastProgrammaticWriteAtRef = useRef(0);
  const ECHO_GRACE_MS = 200;
  // Non-null while the smooth-follow rAF branch is actively driving
  // scrollLeft. onScrollSync treats any event near this value as an engine
  // echo (not a user fight), so continuous follow can never pause itself.
  const followEngineScrollRef = useRef<number | null>(null);
  // Last scrollLeft seen by onScrollSync, to tell a genuine HORIZONTAL user
  // scroll apart from a vertical-only one. Vertical scrolling must NOT pause
  // auto-follow (it doesn't fight the horizontal autoscroll) -- only a
  // horizontal user scroll or a zoom gesture should.
  const lastScrollLeftRef = useRef<number | null>(null);
  // Last scrollLeft we actually pushed into React scrollState. Separate from
  // lastScrollLeftRef: the follow-echo path in onScrollSync updates the latter
  // every frame (so gesture detection stays accurate), which made the rAF
  // "moved > N px" check always see 0 delta and NEVER re-render BeatGrid /
  // ruler / viewport-culled waveforms during smooth follow.
  const lastCommittedScrollLeftRef = useRef<number | null>(null);
  const lastScrollStateCommitAtRef = useRef(0);

  // Vertical zoom (buttons, not gestures)
  // Toast notifications
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastCounterRef = useRef(0);
  const showToast = (message: string) => {
    const id = ++toastCounterRef.current;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      3500,
    );
  };

  // Region selection (editor only) for copy/delete/duplicate hotkeys.
  const [selectedRegionKeys, setSelectedRegionKeys] = useState<RegionSelKey[]>(
    [],
  );
  useRegionSelectionLifecycle({
    songs: state.songs,
    recording: state.recording,
    setSelectedRegionKeys,
  });

  // Region UI state (mute); geometry is project-owned
  const [regions, setRegions] = useState<Map<RegionSelKey, RegionUiState>>(
    new Map(),
  );

  const [regionContextMenu, setRegionContextMenu] =
    useState<RegionContextMenuState | null>(null);

  const {
    regionGeomDraft,
    regionDragRef,
    regionDragCtxRef,
    startRegionDrag,
    writeGeomDraft,
    clearGeomDrafts,
  } = useRegionDrag({
    songs: state.songs,
    markGestureActive: () => markGestureActiveRef.current(),
    scrollerRef: scrollRef,
    sidebarContentRef: sidebarContentRef,
    commitScrollState: (left, width) =>
      commitScrollStateRef.current(left, width),
    onSelectTrackId: (id) => onSelectTrackId?.(id),
  });

  // Light cue actively being dragged across LightTrackLane instances (each
  // lane is its own component, so -- unlike audio regions, which share one
  // regionGeomDraft/regionDragRef in this same closure -- crossing tracks
  // needs a piece of state lifted up here that every lane can read.
  const [lightCueDrag, setLightCueDrag] = useState<LightCueDragState | null>(
    null,
  );
  useEffect(() => {
    if (!lightCueDrag) return;
    const cue = state.songs[lightCueDrag.songIndex]?.lightCues?.find(
      (c) => c.id === lightCueDrag.cueId,
    );
    if (!cue || cue.trackId === lightCueDrag.targetTrackId) {
      setLightCueDrag(null);
    }
  }, [state.songs, lightCueDrag]);

  const getRegionUi = (key: RegionSelKey): RegionUiState =>
    regions.get(key) ?? { muted: false };

  const setRegionUi = (key: RegionSelKey, patch: Partial<RegionUiState>) => {
    setRegions((prev) => {
      const next = new Map(prev);
      next.set(key, { ...getRegionUi(key), ...patch });
      return next;
    });
  };

  const songs = state.songs;
  const hasSongs = songs.length > 0;

  const {
    songEndDrag,
    handleSongEndDrag,
    handleSongEndCommit,
  } = useSongEndDrag();

  const { songLengths, songOffsets, totalLength } = useSongLayout(
    songs,
    allPeaks,
    peaks,
    state.songIndex,
    songEndDrag,
  );

  // Selection and clipboard operations are grouped in selectionActions.ts;
  // this component retains ownership of the underlying React selection state.
  const {
    copySelectedCue,
    deleteSelectedCue,
    selectCue,
    duplicateSelectedCue,
    pasteClipboardCues,
    splitSelectedCueAtPlayhead,
    selectRegion,
    copySelectedRegions,
    cutSelectedRegions,
    cutSelectedCues,
    deleteSelectedRegions,
    duplicateSelectedRegions,
    pasteClipboardRegions,
  } = createTimelineSelectionActions({
    songs,
    selectedCueKeys,
    cueSelection,
    setCueSelection,
    setSelectedCueKeys,
    selectedRegionKeys,
    setSelectedRegionKeys,
    songOffsets,
    songLengths,
    playheadAbsNow,
    showToast,
    onSelectTrackId,
  });

  // The floor the marker reports as "content past here is out of bounds".
  const songContentLengths = useMemo(
    () =>
      songs.map((song, i) =>
        songContentSeconds(
          song,
          allPeaks?.songs[i]?.tracks ??
            (i === state.songIndex ? peaks?.tracks : undefined),
        ),
      ),
    [songs, allPeaks, peaks, state.songIndex],
  );

  const activeSongIndex = state.songIndex >= 0 ? state.songIndex : 0;
  const activeSongLen = songLengths[activeSongIndex] ?? 0;
  // Project-wide cycle: clamp using the song it belongs to (fall back to active).
  const cycleOwnerIndex =
    typeof state.cycle?.songIndex === "number" && state.cycle.songIndex >= 0
      ? state.cycle.songIndex
      : activeSongIndex;
  const cycleSongLen = songLengths[cycleOwnerIndex] ?? activeSongLen;
  const {
    cycle,
    toggleActive: toggleCycle,
    setRange: setCycleRange,
    toggleSkip: toggleCycleSkip,
    commitDrag: commitCycleDrag,
  } = useCycleState(activeSongIndex, cycleSongLen, state.cycle);

  // Display wrap for active loop cycle (not skip). Outside the zone the
  // playhead is free — only hi→lo crossings from inside mirror the engine.
  cycleWrapRef.current = resolveCycleWrapRange(state.cycle, songOffsets);

  // Catch-follow when transport starts playing.
  const wasPlayingRef = useRef(state.playing);
  useEffect(() => {
    if (state.playing && !wasPlayingRef.current) catchFollowOnPlay();
    wasPlayingRef.current = state.playing;
  }, [state.playing, catchFollowOnPlay]);

  // Register editor-tool commands with the application hotkey owner.
  useEffect(() => {
    if (readOnly) return;
    const toolBindings: Array<[Parameters<typeof setTool>[0], string]> = [
      ["pointer", "v"],
      ["pencil", "b"],
      ["eraser", "e"],
      ["scissors", "x"],
      ["stretch", "t"],
    ];
    return toolBindings.map(([tool, key]) =>
      hotkeyManager.registerCommand(
        `timeline.tool.${tool}`,
        key,
        { scope: HotkeyScope.Timeline, priority: 100 },
        () => setTool(tool),
      ),
    ).reduce((disposeAll, dispose) => () => { dispose(); disposeAll(); }, () => {});
  }, [readOnly, setTool]);

  /** Split selected region(s) at the absolute playhead (Logic-style ⌘T). */
  const splitSelectedAtPlayhead = async () => {
    if (selectedRegionKeys.length === 0) {
      showToast("Select a region to trim");
      return;
    }
    // A split shortens the region under any optimistic geometry it still
    // has, so that geometry has to go first -- otherwise the old full-length
    // shape keeps being drawn with the new half on top of it.
    clearGeomDrafts(selectedRegionKeys);
    const splitCount = await splitRegionsAtPlayhead(
      selectedRegionKeys,
      state.songs,
      songOffsets,
      songLengths,
      playheadAbsNow(),
    );
    if (splitCount === 0) {
      showToast("Playhead is not inside the selected region");
    } else {
      showToast(
        splitCount === 1
          ? "Trimmed region at playhead"
          : `Trimmed ${splitCount} regions at playhead`,
      );
      setSelectedRegionKeys([]);
    }
  };

  // Where the project actually ends, and how far the canvas runs past it.
  //
  // The arrangement used to stop dead at the last song, which left nowhere to
  // drag the last end marker TO -- you can only extend a song into space that
  // exists. The slack is free canvas: out of bounds, dimmed (see
  // OutOfBoundsOverlay), and not somewhere the transport will go.
  const projectWidth = Math.max(1, Math.round(totalLength * pxPerSec));
  const trailingSlackPx = Math.round(
    Math.max(
      TRAILING_SLACK_MIN_PX,
      TRAILING_SLACK_SECONDS * pxPerSec,
      // Always out to the right edge. A short set at a low zoom ran out of
      // slack mid-viewport and left bare scrollport after it -- which looks
      // like the timeline ending, when it is the same free canvas the slack
      // is. Filling the viewport also means the hatch is what you drop onto
      // anywhere right of the project, not just for the first 240px.
      scrollState.viewportWidth - projectWidth,
    ),
  );
  const contentWidth = projectWidth + trailingSlackPx;

  // themeVersion: row colours are resolved hex, so a theme swap has to force
  // this to recompute -- see useThemeVersion.
  const themeVersion = useThemeVersion();
  const rows = useMemo(
    () => buildRows(state.tracks, songs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.tracks, songs, themeVersion],
  );
  const [trackReorderPreview, setTrackReorderPreview] = useState<{
    index: number;
    kind: "audio" | "light";
    dropSlot: number;
  } | null>(null);
  const previewRows = useMemo(() => {
    if (trackReorderPreview?.kind !== "audio") return rows;
    const { index, dropSlot } = trackReorderPreview;
    return previewDropReorder(rows, index, dropSlot);
  }, [rows, trackReorderPreview]);

  // Drag & drop state is isolated with the import workflow below.
  const tracksOriginRef = useRef<HTMLDivElement>(null);
  const {
    audioDropFile,
    midiDropName,
    audioDropPreview,
    audioDropPos,
    onTracksDragOver,
    onTracksDragLeave,
    onTracksDrop,
  } = useTimelineFileDrop({
    readOnly,
    viewMode: effectiveViewMode,
    tracks: state.tracks,
    rows,
    songs,
    songOffsets,
    songLengths,
    pxPerSec,
    verticalZoom,
    snapToGrid,
    tracksOriginRef,
    showToast,
  });

  // Imported audio that lands past an authored song end has to be dealt with
  // one way or the other -- see useLongImportGuard for why this watches the
  // project rather than the import calls.
  const longImport = useLongImportGuard(songs);

  // Keep window-level region-drag handlers on the latest layout/snap inputs.
  regionDragCtxRef.current = {
    pxPerSec,
    verticalZoom,
    snapToGrid,
    rows,
    tracks: state.tracks,
    songs,
    cycle,
  };

  // Light-mode derived data (Feature 6). Guarded with optional chaining so an
  // older WebUiState snapshot without the lighting fields still renders.
  const lightTracks = useMemo(
    () => state.lighting.tracks ?? [],
    [state.lighting.tracks],
  );
  const previewLightTracks = useMemo(() => {
    if (trackReorderPreview?.kind !== "light") return lightTracks;
    const { index, dropSlot } = trackReorderPreview;
    return previewDropReorder(lightTracks, index, dropSlot);
  }, [lightTracks, trackReorderPreview]);
  const lightTrackIds = useMemo(
    () => lightTracks.map((t) => t.id),
    [lightTracks],
  );
  const lightFixtures = useMemo(
    () => state.lighting?.fixtures ?? [],
    [state.lighting?.fixtures],
  );
  const lightEnabled = Boolean(state.lighting?.enabled);
  const lightTrackColor = (index: number) => getLightColor(Math.max(0, index));
  const lightTrackColorForId = (trackId: string) =>
    lightTrackColor(lightTracks.findIndex((t) => t.id === trackId));
  const hasLightContent =
    lightEnabled &&
    (lightTracks.length > 0 ||
      songs.some((s) => (s.lightCues ?? []).length > 0));

  // Live 3D stage colors come only from the core binary LED stream
  // (LightSidePanel). Do not re-resolve cues on the frontend.
  const previewColors = useMemo(
    () =>
      ({}) as Record<
        string,
        import("../../lib/light/lightCueInterpolation").LightCueValue
      >,
    [],
  );

  // Derived side-panel selection (after songs, lightTracks, cueSelection are defined).
  const sidePanelSelection = resolveLightSidePanelSelection({
    viewMode: effectiveViewMode,
    cueSelection,
    sidePanelTrackIndex,
    songs,
    tracks: lightTracks,
  });

  // Drop cue selection when the cue itself disappears (delete / reload).
  useEffect(() => {
    if (!cueSelection) return;
    const song = songs[cueSelection.songIndex];
    const cue = song?.lightCues?.find((c) => c.id === cueSelection.cueId);
    if (!cue) setCueSelection(null);
  }, [songs, cueSelection]);

  const applyZoomAt = (nextPxPerSec: number, focusClientX?: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const oldPx = pxPerSecRef.current;
    const clampedNext = Math.max(
      MIN_PX_PER_SEC,
      Math.min(MAX_PX_PER_SEC, nextPxPerSec),
    );
    if (Math.abs(clampedNext - oldPx) < 0.001) return;

    const k = clampedNext / oldPx;
    const rect = scroller.getBoundingClientRect();

    // Anchor the zoom at the actual gesture focus -- the cursor for wheel-zoom,
    // the pinch midpoint for pinch, the viewport center for the slider. The
    // playhead is NOT pinned while zooming: it just sits at its natural
    // document position (the rAF loop snaps it to px during a gesture), so
    // whatever is under the cursor/fingers stays exactly under them through
    // the zoom ("pinch isn't landing quite where it should"). The old
    // marker-anchored pin drifted away from the pinch midpoint and landed
    // somewhere else when the gesture ended.
    let focusX =
      typeof focusClientX === "number"
        ? focusClientX - rect.left
        : rect.width / 2;
    if (focusX < 0 || focusX > rect.width) focusX = rect.width / 2;

    // Base for the incremental zoom step: use the pending (not-yet-committed)
    // target if the layout effect hasn't applied the previous step yet --
    // otherwise rapid successive wheel/pinch steps would all read the stale
    // DOM scrollLeft and lose the intermediate increments.
    const currentScrollLeft =
      pendingScrollLeftRef.current !== null
        ? pendingScrollLeftRef.current
        : scroller.scrollLeft;

    const newScrollLeftWanted = k * (currentScrollLeft + focusX) - focusX;

    pxPerSecRef.current = clampedNext;
    pendingScrollLeftRef.current = Math.max(0, newScrollLeftWanted);

    // A trackpad pinch/scroll-zoom fires wheel/gesturechange far faster than
    // the display can paint -- committing setPxPerSec on every single one
    // forces a full re-render of every region + ruler mark + waveform canvas
    // per event, backing up the event queue ("massively lags during zoom"). Every
    // other reader of the zoom level during a gesture already goes through
    // pxPerSecRef (always current, see its assignment two lines up) rather
    // than the pxPerSec render value, so collapsing the REACT commit to once
    // per frame drops no precision -- the rAF callback below always reads
    // whatever pxPerSecRef.current is by the time it actually fires.
    if (!zoomCommitRafRef.current) {
      zoomCommitRafRef.current = requestAnimationFrame(() => {
        zoomCommitRafRef.current = 0;
        setPxPerSec(pxPerSecRef.current);
      });
    }
  };

  // Apply the zoom-focus scroll target AND the playhead marker in ONE atomic
  // batch, synchronously before paint. This is the ONLY writer of scrollLeft
  // during a zoom gesture: applyZoomAt only queues the target refs above, and
  // the rAF loop's follow/reveal branches are disabled while a gesture is
  // active (gestureActiveNowRef). A single writer keeps the timeline content
  // and the marker in lockstep -- two writers (e.g. an earlier version also
  // applying the pending value inside the rAF tick) fought each other and
  // wobbled the whole timeline ("not just the playhead but the entire timeline is wobbling").
  useLayoutEffect(() => {
    if (scrollRef.current) {
      const scroller = scrollRef.current;
      if (pendingScrollLeftRef.current !== null) {
        const maxLeft = Math.max(
          0,
          scroller.scrollWidth - scroller.clientWidth,
        );
        const targetScrollLeft = Math.max(
          0,
          Math.min(maxLeft, pendingScrollLeftRef.current),
        );
        scroller.scrollLeft = targetScrollLeft;
        programmaticScrollLeftRef.current = scroller.scrollLeft;
        lastProgrammaticWriteAtRef.current = performance.now();
        // Marker: same document position the rAF loop derives during a gesture
        // (playheadAbsoluteSec * pxPerSec -- the clock is frozen while
        // zooming). Writing it here, in the same commit as the scroll write,
        // means the two can never land a frame apart.
        const px = playheadAbsoluteSecRef.current * pxPerSecRef.current;
        if (playheadRef.current) playheadRef.current.style.left = `${px}px`;
        if (playheadHandleRef.current)
          playheadHandleRef.current.style.left = `${px}px`;
        commitScrollStateRef.current(
          targetScrollLeft,
          scroller.clientWidth || 1000,
        );
        pendingScrollLeftRef.current = null;
      } else {
        commitScrollStateRef.current(
          scroller.scrollLeft,
          scroller.clientWidth || 1000,
        );
      }
    }
  }, [pxPerSec]);

  const applyZoomAtRef = useRef(applyZoomAt);
  applyZoomAtRef.current = applyZoomAt;

  // Non-passive wheel & gesture listeners stay attached to the timeline root.
  useTimelineZoomGestures({
    containerRef,
    pxPerSecRef,
    applyZoomAtRef,
    markGestureActiveRef,
    markZoomActiveRef,
    endGestureRef,
  });

  const {
    seekFromClientX,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancelOrLost,
  } = useTimelineScrub({
    hasSongs,
    songs,
    songOffsets,
    songLengths,
    pxPerSecRef,
    snapToGrid,
    bodyRef: timelineBodyRef,
    scrollRef,
    draggingRef: dragging,
    livePlayheadRef: getLivePlayheadAbsoluteRef,
    setPlayheadAbsoluteSec,
    catchFollowOnSeek,
  });

  const {
    marqueeRect,
    onTracksPointerDown,
    onTracksPointerMove,
    onTracksPointerUp,
    onTracksPointerCancel,
  } = useTimelineMarquee({
    viewMode: effectiveViewMode,
    lightTrackIds,
    songs,
    songOffsets,
    songLengths,
    pxPerSec,
    verticalZoom,
    rows,
    tracks: state.tracks,
    hasSongs,
    readOnly,
    tracksOriginRef,
    selectedRegionKeys,
    selectedCueKeys,
    setSelectedRegionKeys,
    setSelectedCueKeys,
    setCueSelection,
    seekFromClientX,
  });

  // Light-lane coordinate helpers (mirror seekFromClientX's math): absolute
  // project seconds from a clientX, and grid-snapped local seconds.
  const toAbsSec = (clientX: number) => {
    const bodyEl = timelineBodyRef.current;
    if (!bodyEl) return 0;
    const rect = bodyEl.getBoundingClientRect();
    return timelineSecondsAtClientX(
      clientX,
      rect.left,
      pxPerSecRef.current,
    );
  };
  /**
   * Landmarks per song for free (unsnapped) drags -- see detents.ts.
   *
   * Memoized on the song list because a cue drag asks for it once per
   * gesture, and rebuilding a few hundred numbers on every pointermove would
   * cost more than the drag itself.
   */
  const detentsBySong = useMemo(() => {
    const cache = new Map<number, number[]>();
    return (songIndex: number) => {
      const hit = cache.get(songIndex);
      if (hit) return hit;
      const built = songDetents(songs[songIndex], songIndex, {
        cycle,
        songLength: songLengths[songIndex] ?? 0,
      });
      cache.set(songIndex, built);
      return built;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs, songLengths, cycle]);

  const snapLocalSec = (songIndex: number, localSeconds: number) => {
    const song = songs[songIndex];
    return snapSongLocalSeconds(
      song,
      localSeconds,
      pxPerSecRef.current,
      snapToGrid,
    );
  };

  // Ruler / playhead-handle scrub interaction lives in useTimelineScrub.
  const onScrollSync = (e: React.UIEvent<HTMLDivElement>) => {
    // Vertical sidebar mirror: write HERE (scroll event is sync with the
    // browser's scroll position) so the left track list never lags a frame
    // behind the right pane. rAF only re-applies as a safety net.
    const scroller = e.currentTarget;
    if (sidebarContentRef.current)
      sidebarContentRef.current.style.transform = `translate3d(0, -${scroller.scrollTop}px, 0)`;
    // Hard-clamp past the real content end (macOS rubber-band / trackpad
    // can report scrollLeft beyond scrollWidth-clientWidth briefly).
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    if (scroller.scrollLeft < 0) scroller.scrollLeft = 0;
    else if (scroller.scrollLeft > maxLeft) scroller.scrollLeft = maxLeft;
    const left = scroller.scrollLeft;
    const programmedLeft = programmaticScrollLeftRef.current;
    const exactEcho =
      programmedLeft !== null && Math.abs(left - programmedLeft) < 0.5;
    // Coalesced echo: a programmatic write landed very recently (continuous
    // "smooth" follow writes every rAF frame, faster than the browser
    // necessarily dispatches `scroll` events for each one) -- see
    // lastProgrammaticWriteAtRef's doc comment.
    const recentEcho =
      performance.now() - lastProgrammaticWriteAtRef.current < ECHO_GRACE_MS;
    // Continuous smooth-follow owns the scroller. Any event within a few
    // pixels of the engine target is an echo of our own write (browser
    // rounding / delayed coalesced events), NOT a user fight. Only a real
    // manual drag that pulls the viewport away from the follow anchor
    // should pause autofollow -- without this, own scroll events flipped
    // gestureActive every ~150ms and the timeline stuttered in 700ms chunks.
    const followTarget = followEngineScrollRef.current;
    const followEcho =
      followTarget !== null && Math.abs(left - followTarget) < 32;
    if (exactEcho || recentEcho || followEcho) {
      // Echo of our own auto-follow/zoom-focus write. Do NOT touch
      // lastCommittedScrollLeftRef here -- the rAF loop is the sole owner of
      // React scrollState during follow. Only keep lastScrollLeftRef fresh so
      // a later real user drag is measured correctly.
      lastScrollLeftRef.current = left;
      return;
    }
    // A true user horizontal move supersedes any delayed programmatic echo.
    programmaticScrollLeftRef.current = null;
    followEngineScrollRef.current = null;
    // null means "no baseline yet" (mount / scroll-restore) -- that first
    // event never counts as a user fight.
    const movedHorizontally =
      lastScrollLeftRef.current !== null && left !== lastScrollLeftRef.current;
    lastScrollLeftRef.current = left;
    lastCommittedScrollLeftRef.current = left;
    lastScrollStateCommitAtRef.current = performance.now();
    // Vertical-only scroll (scrollTop changed, scrollLeft didn't) is not a
    // user fight for the horizontal timeline -- don't pause auto-follow for
    // it ("vertical scroll stops the auto-scroll").
    if (movedHorizontally) {
      markGestureActiveRef.current();
      // Manual pan while playing suspends follow; catch flags re-enable later.
      if (playingRef.current) suspendFollowFromUserScroll();
    }
    commitScrollStateRef.current(left, scroller.clientWidth);
  };

  const handleSidebarWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const scroller = scrollRef.current;
    if (!scroller) return;

    const lineMult =
      e.deltaMode === 1 ? 24 : e.deltaMode === 2 ? scroller.clientHeight : 1;
    const dy = e.deltaY * lineMult;
    const dx = e.deltaX * lineMult;

    if (e.shiftKey && !dx && dy) {
      scroller.scrollLeft += dy;
    } else {
      if (dy) {
        scroller.scrollTop += dy;
        if (sidebarContentRef.current) {
          sidebarContentRef.current.style.transform = `translate3d(0, -${scroller.scrollTop}px, 0)`;
        }
      }
      if (dx) {
        scroller.scrollLeft += dx;
      }
    }
  }, []);

  const handleAutoScroll = useCallback((deltaY: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTop += deltaY;
    if (sidebarContentRef.current) {
      sidebarContentRef.current.style.transform = `translate3d(0, -${scroller.scrollTop}px, 0)`;
    }
  }, []);

  const scrollToTrackIndex = useCallback(
    (trackIdx: number) => {
      const scroller = scrollRef.current;
      if (!scroller || trackIdx < 0) return;
      const laneH = laneHeightPx(verticalZoom);
      const showHintSpacer =
        effectiveViewMode === "audio" ? hasLightContent : true;
      const hintHeight =
        effectiveViewMode === "light" ? AUDIO_HINT_HEIGHT : LIGHT_HINT_HEIGHT;
      const baseTop =
        SECTION_LANE_HEIGHT + EVENT_LANE_HEIGHT + (showHintSpacer ? hintHeight : 0);

      let rowIndex = trackIdx;
      if (effectiveViewMode === "audio") {
        const foundRowIdx = rows.findIndex((r) => r.headerIndex === trackIdx);
        if (foundRowIdx >= 0) rowIndex = foundRowIdx;
      }
      const rowTop = baseTop + rowIndex * laneH;
      const rowBottom = rowTop + laneH;
      const currentScrollTop = scroller.scrollTop;
      const clientHeight = scroller.clientHeight;

      if (rowTop < currentScrollTop) {
        scroller.scrollTop = Math.max(0, rowTop - 12);
        if (sidebarContentRef.current) {
          sidebarContentRef.current.style.transform = `translate3d(0, -${scroller.scrollTop}px, 0)`;
        }
      } else if (rowBottom > currentScrollTop + clientHeight) {
        scroller.scrollTop = rowBottom - clientHeight + 12;
        if (sidebarContentRef.current) {
          sidebarContentRef.current.style.transform = `translate3d(0, -${scroller.scrollTop}px, 0)`;
        }
      }
    },
    [verticalZoom, effectiveViewMode, hasLightContent, rows],
  );

  useTimelineTrackFocus({
    tracks: state.tracks,
    lightTracks,
    projectName: state.projectName,
    selectedTrackId,
    onSelectTrackId,
    setSidePanelTrackIndex,
    setCueSelection,
    setSelectedCueKeys,
    scrollToTrackIndex,
  });

  const keyboardActions = useMemo(
    () => ({
      copySelectedCue,
      cutSelectedCues,
      pasteClipboardCues,
      duplicateSelectedCue,
      splitSelectedCueAtPlayhead,
      deleteSelectedCue,
      setCueSelection: (v: CueSelKey | null) => selectCue(v),
      selectAllCues: () => {
        const all: CueSelKey[] = [];
        state.songs.forEach((song, si) => {
          for (const c of song.lightCues ?? []) {
            if (c.id) all.push({ songIndex: si, cueId: c.id });
          }
        });
        setSelectedCueKeys(all);
        setCueSelection(all[all.length - 1] ?? null);
      },
      copySelectedRegions,
      cutSelectedRegions,
      pasteClipboardRegions,
      duplicateSelectedRegions,
      splitSelectedAtPlayhead,
      deleteSelectedRegions,
      setSelectedRegionKeys,
    }),
    // Handlers close over latest state; rebind when selection / mode shifts.
    // The playhead is deliberately NOT a dependency: these handlers read it
    // live via playheadAbsNow(), so rebinding them on it would be both
    // pointless and (at 60 fps) the most expensive dep in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      cueSelection,
      selectedCueKeys,
      selectedRegionKeys,
      state.songs,
      songOffsets,
      songLengths,
      effectiveViewMode,
    ],
  );
  useTimelineKeyboard({
    readOnly,
    effectiveViewMode,
    hasCueSelection: Boolean(cueSelection) || selectedCueKeys.length > 0,
    selectedRegionKeys,
    songs: state.songs,
    actions: keyboardActions,
  });

  const currentSongIdx = state.songIndex >= 0 ? state.songIndex : 0;

  // Refs kept fresh on every render so the rAF loops below (both the
  // "smooth" scroll-follow and the playhead-marker display damping) always
  // read the LATEST value without needing to restart when it changes --
  // driving them from a dependency-array effect instead had them react to
  // playheadAbsoluteSec only once React actually re-renders/commits after
  // useContinuousPlayhead's OWN separate rAF loop calls setState, which
  // isn't guaranteed to land in the same frame every time. Two independent,
  // self-paced 60fps loops (this one and the hook's) stay visually in sync
  // far more reliably than chaining one through the other's render cycle.
  const playheadAbsoluteSecRef = useRef(playheadAbsoluteSec);
  playheadAbsoluteSecRef.current = playheadAbsoluteSec;
  const contentWidthRef = useRef(contentWidth);
  contentWidthRef.current = contentWidth;
  const followModeRef = useRef(followMode);
  followModeRef.current = followMode;
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;
  const currentSongIdxRef = useRef(currentSongIdx);
  currentSongIdxRef.current = currentSongIdx;

  // Auto-scroll to keep the playhead in view lives ENTIRELY in the dedicated
  // rAF loop below -- one code path for every follow mode, so every kind of
  // move (continuous smooth follow, "snap"-mode edge pans, and reveals on
  // song change / stop / far seek) is a smooth bounded-duration glide rather
  // than a teleport. Driving it from React's render cycle instead is what
  // produced the cross-render timing jitter fixed earlier. followMode="off"
  // only opts out of being continuously yanked around DURING playback; a
  // deliberate song pick or a stop still brings the playhead into view, same
  // as clicking an item in a list still scrolls to it even with "autoscroll"
  // off elsewhere in this app.

  // "smooth" follow's dedicated rAF loop -- fully decoupled from React's
  // render cycle (see the big effect above for why). playheadAbsoluteSec
  // itself stays raw/precise everywhere else (e.g. localPlayhead above,
  // used for split-at-playhead).
  //
  // The playhead MARKER is moved by writing its `left` style directly to the
  // DOM node (playheadRef) from this loop, NEVER through React state:
  // driving it via setState() re-rendered the timeline every frame and --
  // worse -- the committed render (and thus the marker's new position) landed
  // a frame AFTER the native scrollLeft write below had already taken effect,
  // so the marker visibly lagged/stuttered behind a viewport that was moving
  // every frame ("the playhead became insanely buggy"). Writing the style attribute
  // in the same tick as the scroll write makes the two atomic within a frame;
  // there is no React commit in between to desync them.
  //
  // The loop owns a single animated scroll position and glides it toward the
  // playhead-anchored target with a per-frame speed cap: normal follow eases
  // at ~25%/frame (filtering the small clock wobble), while big jumps --
  // song change, stop/full-stop reset, far seek -- PAN instead of teleporting
  // ("when switching songs, scroll smoothly to the right position", "time
  // seemed to stop and then animated to catch up"). It runs ONCE (the
  // song index is tracked through a ref) so a song change doesn't restart it
  // and lose the in-flight glide.
  // Ruler uses real CSS position:sticky (see markup). Do NOT emulate sticky
  // with translateY(scrollTop): native scroll paints on the compositor one
  // frame before JS can counter-translate → vertical jitter.
  // Playhead: needle is absolute full-height; the triangle handle lives INSIDE
  // the sticky ruler (sticky inside absolute is broken — handle would stick to
  // the playhead box, not the scrollport).
  const playheadRef = useRef<HTMLDivElement>(null);
  const playheadHandleRef = useRef<HTMLDivElement>(null);

  // Left sidebar track list lives OUTSIDE the right scroller; mirror its
  // vertical offset from the right pane's scrollTop. Applied synchronously
  // from onScroll (and rAF as a safety net) — never via React state.
  const syncSidebarScrollMirror = () => {
    const scroller = scrollRef.current;
    if (!scroller || !sidebarContentRef.current) return;
    const st = scroller.scrollTop;
    sidebarContentRef.current.style.transform = `translate3d(0, -${st}px, 0)`;
  };

  useEffect(() => {
    // Engine-owned scrollLeft; null while idle (not following / not panning).
    let engineScrollLeft: number | null = null;
    let displayPx = playheadAbsoluteSecRef.current * pxPerSecRef.current;
    // Reveal-pan state: the scroll position being animated toward a reveal
    // target; null when no reveal is in flight.
    let revealScroll: number | null = null;
    // Pan engine state, captured by startPan() when a pan begins or when the
    // target jumps further away mid-pan. panStartDist also decides the regime
    // in glide(): real pan (ease-out curve) vs. follow wobble (exponential).
    let panStartDist = 0;
    let panFrom = 0;
    let panElapsedFrames = 0;
    // Last position the reveal logic compared against, to detect a LARGE
    // jump. Updating it every idle frame is what makes ordinary pauses and
    // manual scrolls never fire a reveal.
    let lastRevealPx = displayPx;
    let lastSongIdx = currentSongIdxRef.current;
    const placePlayhead = (px: number) => {
      if (playheadRef.current) playheadRef.current.style.left = `${px}px`;
      if (playheadHandleRef.current)
        playheadHandleRef.current.style.left = `${px}px`;
    };
    placePlayhead(displayPx);
    syncSidebarScrollMirror();
    let firstTick = true;

    const tick = () => {
      // Sidebar mirror safety net (primary write is onScroll — see below).
      syncSidebarScrollMirror();

      // Live playhead from the clock's own ref -- not the React-state mirror
      // (playheadAbsoluteSecRef), which only updates on commit and can lag
      // behind the clock rAF by one or more frames.
      // pxPerSecRef.current (NOT a render-copied mirror): applyZoomAt writes
      // it synchronously on every wheel/pinch tick, so this loop computes the
      // playhead's document position with the zoom scale CURRENT the same
      // frame the zoom-focus scroll is applied -- no one-frame stale-scale
      // gap, which made the marker wobble left-right during a zoom gesture.
      const liveSec = getLivePlayheadAbsoluteRef.current();
      const px = liveSec * pxPerSecRef.current;
      playheadAbsoluteSecRef.current = liveSec;
      const songJumped = currentSongIdxRef.current !== lastSongIdx;
      lastSongIdx = currentSongIdxRef.current;

      // The zoom has finished and the view still owes the playhead a catch-up
      // (see pendingFollowAfterZoomRef). Treat it exactly like a song jump so
      // it uses the same glide rather than a teleport, and only when the
      // needle actually ended up off-screen -- a zoom that left it in view
      // needs no scroll at all.
      let zoomCatchUp = false;
      if (pendingFollowAfterZoomRef.current && !gestureActiveNowRef.current) {
        pendingFollowAfterZoomRef.current = false;
        zoomCatchUp =
          followModeRef.current !== "off" &&
          !!scrollRef.current &&
          !isPositionVisible(
            px,
            scrollRef.current.scrollLeft,
            scrollRef.current.clientWidth || 1000,
          );
      }

      // gestureActiveNowRef, NOT a React-state mirror: it's set synchronously
      // in the same tick as the wheel/pinch handler, so this rAF loop can
      // never observe a stale "not zooming" for a frame while React's own
      // update is still in flight -- that one-frame race (this loop writing
      // the playhead-anchor scroll target at the same instant applyZoomAt's
      // effect writes the zoom-focus target) was what made the playhead
      // visibly jump during a zoom gesture while autofollowing.
      const following =
        playingRef.current &&
        !gestureActiveNowRef.current &&
        !dragging.current &&
        followModeRef.current === "smooth";
      const scroller = scrollRef.current;
      const viewWidth = scroller ? scroller.clientWidth || 1000 : 1000;
      // Prefer the live DOM max (scrollWidth) over the React contentWidth
      // mirror -- after zoom/layout the two can lag a frame and writing past
      // the real max felt like "scrolling into empty space".
      const maxScrollLeft = scroller
        ? Math.max(0, scroller.scrollWidth - scroller.clientWidth)
        : Math.max(0, contentWidthRef.current - viewWidth);
      const target = Math.min(
        maxScrollLeft,
        Math.max(0, px - viewWidth * 0.25),
      );

      // Begin (or re-anchor) a pan from `fromPos` toward the current target.
      const startPan = (fromPos: number) => {
        panStartDist = Math.abs(target - fromPos);
        panFrom = fromPos;
        panElapsedFrames = 0;
      };

      // Step `from` toward `target`. Three regimes:
      //  - REAL PAN: ease-out over ~PAN_FRAMES for song changes / large jumps.
      //  - STEADY FOLLOW (following===true): pin scrollLeft to the moving
      //    playhead-anchored target every frame. Target already advances
      //    with the live clock -- free-running at dt*pxPerSec drifted.
      //  - SNAP/REVEAL catch-up: exponential approach for medium pans.
      const glide = (from: number) => {
        const diff = target - from;
        const dist = Math.abs(diff);
        if (dist < 0.5) return target;
        const PAN_FRAMES = 18; // ~0.3s
        if (panStartDist > viewWidth * 0.25 && panElapsedFrames < PAN_FRAMES) {
          panElapsedFrames++;
          const t = Math.min(1, panElapsedFrames / PAN_FRAMES);
          const f = 1 - (1 - t) ** 3; // easeOutCubic
          const next = panFrom + (target - panFrom) * f;
          if (t >= 1) panStartDist = 0; // pan done
          return next;
        }
        panStartDist = 0;
        if (following) return target;
        const step = Math.max(dist * 0.25, 1);
        return diff > 0 ? from + step : from - step;
      };

      if (following && scroller) {
        revealScroll = null;
        if (engineScrollLeft === null) {
          engineScrollLeft = scroller.scrollLeft;
          startPan(engineScrollLeft);
        } else {
          // Target jumped further away mid-pan (e.g. another song change) --
          // re-anchor the ease-out curve so it restarts fast.
          const still = Math.abs(target - engineScrollLeft);
          if (still > panStartDist) startPan(engineScrollLeft);
        }
        engineScrollLeft = Math.min(
          maxScrollLeft,
          Math.max(0, glide(engineScrollLeft)),
        );
        scroller.scrollLeft = engineScrollLeft;
        engineScrollLeft = scroller.scrollLeft; // re-read in case browser clamped it
        // Always mark as programmatic while following, even if the write was
        // a sub-pixel no-op -- keeps onScrollSync's echo window fresh.
        programmaticScrollLeftRef.current = engineScrollLeft;
        lastProgrammaticWriteAtRef.current = performance.now();
        followEngineScrollRef.current = engineScrollLeft;
        // Commit React scrollState from THIS loop only, using a dedicated
        // ref that onScrollSync echoes do not touch. BeatGrid / Ruler /
        // viewport-culled peaks all read scrollState -- if we skip this,
        // the timeline scrolls under a frozen grid/waveform layer.
        const nowCommit = performance.now();
        const movedSinceCommit = Math.abs(
          (lastCommittedScrollLeftRef.current ?? Infinity) - engineScrollLeft,
        );
        if (
          movedSinceCommit > 8 ||
          nowCommit - lastScrollStateCommitAtRef.current > 50
        ) {
          lastCommittedScrollLeftRef.current = engineScrollLeft;
          lastScrollStateCommitAtRef.current = nowCommit;
          lastScrollLeftRef.current = engineScrollLeft;
          commitScrollStateRef.current(engineScrollLeft, viewWidth);
        }
        // Marker: during active large panning (song change / far seek), hold
        // marker pinned at 25% viewport while timeline slides under it.
        // During normal continuous follow, anchor marker directly to true `px`
        // so any sub-pixel scroller adjustments never cause forward/backward marker jumps.
        const isPanning =
          panStartDist > viewWidth * 0.25 && panElapsedFrames < 18;
        const pinnedTarget = px - viewWidth * 0.25;
        displayPx =
          isPanning && pinnedTarget >= 0 && pinnedTarget <= maxScrollLeft
            ? engineScrollLeft + viewWidth * 0.25
            : px;
      } else {
        // Not smoothly following this tick (paused, off/snap mode, or a
        // gesture is in progress) -- drop the follow anchor.
        engineScrollLeft = null;
        followEngineScrollRef.current = null;
        // Marker tracks the true playhead position directly without lag
        displayPx = px;

        // Scrub edge-scroll: while the user drags the playhead on the ruler,
        // pan the timeline so the needle never gets stuck at a viewport edge
        // (DAW convention). Hard scroll (not glide) so it tracks the pointer.
        if (dragging.current && scroller && !gestureActiveNowRef.current) {
          const margin = 48;
          const left = scroller.scrollLeft;
          const right = left + viewWidth;
          let nextLeft = left;
          if (px > right - margin) {
            nextLeft = Math.min(maxScrollLeft, px - viewWidth + margin);
          } else if (px < left + margin) {
            nextLeft = Math.max(0, px - margin);
          }
          if (Math.abs(nextLeft - left) > 0.5) {
            scroller.scrollLeft = nextLeft;
            programmaticScrollLeftRef.current = scroller.scrollLeft;
            lastProgrammaticWriteAtRef.current = performance.now();
            lastCommittedScrollLeftRef.current = scroller.scrollLeft;
            lastScrollLeftRef.current = scroller.scrollLeft;
            commitScrollStateRef.current(scroller.scrollLeft, viewWidth);
          }
          revealScroll = null;
        }

        // Animated PANS (glide), unified for every follow mode and for
        // playing and stopped alike. Three triggers, all gliding instead of
        // teleporting ("glide is needed not just in smooth mode", "not abruptly but smoothly"):
        //  - "snap"-mode edge: while playing and followMode==="snap", pan
        //    once the playhead nears a viewport edge (the old behavior was a
        //    hard jump in a React effect).
        //  - Song change / stop / far seek in any mode: bring the new
        //    playhead into view (previously only revealed while stopped).
        //  - A pan already in flight continues (revealScroll !== null).
        // Guarded against scrubbing (dragging), zooming (gesture), and
        // manual scrolling (px doesn't move then, so lastRevealPx stays
        // equal). While playing in "smooth" the follow branch above owns the
        // scroll, so this else-branch logic never runs for it.
        // First tick after mount (== just switched to this tab, see
        // `firstTick`'s doc comment): if the playhead isn't already inside
        // the freshly-mounted scroller's default viewport, treat that as a
        // jump too, so it gets the exact same reveal-pan animation a song
        // change gets instead of sitting off-screen until the next real
        // jump (or, if paused with follow off, forever). Guarded to fire at
        // most once per mount regardless of whether a pan actually starts
        // this tick (dragging/gesture below could still defer it a frame).
        const notYetVisible =
          firstTick &&
          !!scroller &&
          !isPositionVisible(px, scroller.scrollLeft, viewWidth);
        // Large playhead jumps only trigger a reveal pan when the needle is
        // actually off-screen. Scrubbing/clicking inside the viewport must
        // leave scrollLeft alone.
        const bigJump = Math.abs(px - lastRevealPx) > pxPerSecRef.current * 2.0;
        const outsideView =
          !!scroller && !isPositionVisible(px, scroller.scrollLeft, viewWidth);
        const jumped =
          songJumped ||
          notYetVisible ||
          zoomCatchUp ||
          (bigJump && outsideView);
        const snapEdge =
          playingRef.current &&
          followModeRef.current === "snap" &&
          scroller &&
          !gestureActiveNowRef.current &&
          !dragging.current;
        let overEdge = false;
        if (snapEdge) {
          const currentLeft = revealScroll ?? scroller!.scrollLeft;
          overEdge =
            px > currentLeft + viewWidth - 120 || px < currentLeft + 40;
        }
        const needPan = jumped || overEdge;
        if (
          scroller &&
          !dragging.current &&
          !gestureActiveNowRef.current &&
          (revealScroll !== null || needPan)
        ) {
          if (revealScroll === null) {
            const startLeft = scroller.scrollLeft;
            const d0 = Math.abs(target - startLeft);
            // Already at the target (e.g. playhead pinned at the very end,
            // where the 25% anchor clamps to maxScrollLeft) -- nothing to pan.
            if (d0 >= 0.5) {
              revealScroll = startLeft;
              startPan(startLeft);
            }
          } else {
            const still = Math.abs(target - revealScroll);
            if (still > panStartDist) startPan(revealScroll);
          }
          if (revealScroll !== null) {
            revealScroll = Math.min(
              maxScrollLeft,
              Math.max(0, glide(revealScroll)),
            );
            const settled = Math.abs(target - revealScroll) < 0.5;
            if (settled) revealScroll = target;
            const before = scroller.scrollLeft;
            scroller.scrollLeft = revealScroll;
            if (Math.abs(before - scroller.scrollLeft) > 0.5) {
              programmaticScrollLeftRef.current = scroller.scrollLeft;
              lastProgrammaticWriteAtRef.current = performance.now();
            }
            const revealLeft = scroller.scrollLeft;
            const revealMoved = Math.abs(
              (lastCommittedScrollLeftRef.current ?? Infinity) - revealLeft,
            );
            if (revealMoved > 8 || settled) {
              lastCommittedScrollLeftRef.current = revealLeft;
              lastScrollStateCommitAtRef.current = performance.now();
              lastScrollLeftRef.current = revealLeft;
              commitScrollStateRef.current(revealLeft, viewWidth);
            }
            if (settled) revealScroll = null;
          }
        } else {
          revealScroll = null;
        }
      }

      lastRevealPx = px;
      firstTick = false;

      // Write the marker EXCEPT while a zoom-focus scroll commit is pending.
      // applyZoomAt updates pxPerSecRef.current synchronously, so px is
      // already the NEW-scale position while the DOM scrollLeft is still the
      // OLD one until the [pxPerSec] layout effect commits the atomic
      // scroll+marker write. If this loop painted the marker here it would
      // run one frame ahead of the scroll and the playhead would visibly
      // wobble over the content ("the playhead is still wobbling"). When the
      // pending target is consumed, the DOM is consistent again and the loop
      // resumes writing the marker itself.
      if (pendingScrollLeftRef.current === null) {
        placePlayhead(displayPx);
      }
    };
    // Shared frame driver: this loop follows/animates a playhead that cannot
    // move while the window is hidden with the transport stopped, so it is
    // suspended with everything else in that state and resumes on the frame
    // the window comes back (see rafLoop / appActivity).
    return addRafTask(tick);
  }, [gestureActiveNowRef, pendingFollowAfterZoomRef]);

  // ── Toolbar ──────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-default/30 bg-background-secondary"
    >
      {/* Toast overlay */}
      <ToastContainer
        toasts={toasts}
        onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))}
      />

      <TimelineToolbar
        songCount={songs.length}
        totalLength={totalLength}
        readOnly={readOnly}
        canUndo={Boolean(state.canUndo)}
        canRedo={Boolean(state.canRedo)}
        undoLabel={state.undoLabel}
        redoLabel={state.redoLabel}
        effectiveViewMode={effectiveViewMode}
        setViewMode={setViewMode}
        snapToGrid={snapToGrid}
        lightTrueColors={lightTrueColors}
        setLightTrueColors={setLightTrueColors}
        setSnapToGrid={setSnapToGrid}
        followMode={followMode}
        cycleFollowMode={cycleFollowMode}
        catchOnPlay={catchOnPlay}
        setCatchOnPlay={setCatchOnPlay}
        catchOnSeek={catchOnSeek}
        setCatchOnSeek={setCatchOnSeek}
        tool={effectiveTool}
        setTool={setTool}
        hasCueSelection={Boolean(cueSelection) || selectedCueKeys.length > 0}
        hasRegionSelection={selectedRegionKeys.length > 0}
        onCopy={
          effectiveViewMode === "light" ? copySelectedCue : copySelectedRegions
        }
        onDelete={
          effectiveViewMode === "light"
            ? deleteSelectedCue
            : deleteSelectedRegions
        }
        onCut={
          effectiveViewMode === "light" ? cutSelectedCues : cutSelectedRegions
        }
        onSplit={
          effectiveViewMode === "light"
            ? () => void splitSelectedCueAtPlayhead()
            : () => void splitSelectedAtPlayhead()
        }
        pxPerSec={pxPerSec}
        applyZoomAt={applyZoomAt}
        markGestureActive={() => markGestureActiveRef.current()}
        markZoomActive={() => markZoomActiveRef.current()}
        verticalZoom={verticalZoom}
        setVerticalZoom={setVerticalZoom}
      />

      {!hasSongs ? (
        <EmptyProjectState
          title="No songs yet"
          description="A song is the container for its tracks, tempo and light cues. Add one and the arrangement opens up here."
          actions={emptyProjectActions({
            onCreateSong: () => void builder.songAdd(),
          })}
        />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {!readOnly && (
            <TimelineSidebar
              state={state}
              rows={previewRows}
              verticalZoom={verticalZoom}
              effectiveViewMode={effectiveViewMode}
              lightTracks={previewLightTracks}
              lightFixtures={lightFixtures}
              lightEnabled={lightEnabled}
              lightTrackColor={lightTrackColor}
              hasLightContent={hasLightContent}
              sidePanelTrackIndex={sidePanelTrackIndex}
              setSidePanelTrackIndex={setSidePanelTrackIndex}
              setCueSelection={() => selectCue(null)}
              sidebarContentRef={sidebarContentRef}
              selectedTrackId={selectedTrackId}
              selectedTrackIds={selectedTrackIds}
              onSelectTrack={(id, gesture) => {
                setSelectedRegionKeys([]);
                onSelectTrackId?.(id, gesture);
              }}
              onWheel={handleSidebarWheel}
              onAutoScroll={handleAutoScroll}
              onTrackReorderPreview={setTrackReorderPreview}
            />
          )}

          {/* Right Scrollable Timeline View (Horizontally & Vertically).

              The wrapper exists only to hang the edge fades on: they have to
              be positioned against the SCROLLPORT, and an absolutely
              positioned child of a scroller is laid out against its content,
              so it would slide away the moment you scrolled. */}
          {/* min-w-0 + overflow-hidden are load-bearing: a flex item's
              automatic minimum size is its CONTENT, and the content here is
              the whole arrangement -- twenty thousand pixels of it. Without
              them this wrapper claims that width and shoves the inspector
              off the right edge of the window. The scroller itself never
              needed them because `overflow: auto` resolves min-width to 0. */}
          <div
            className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${
              scrollShadowActive ? "rs-hshadow" : ""
            }`}
          >
            <div
              ref={scrollRef}
              // Base cursor is the ordinary one. col-resize used to sit on the
              // whole scrollport, so every empty gap in the arrangement claimed
              // to be draggable; the surfaces that ARE scrubbable -- the ruler,
              // the playhead handle -- set it themselves, and each lane sets
              // whatever its current tool means.
              className="h-full w-full min-h-0 overflow-auto relative select-none focus:outline-none"
              style={{
                // No transform/filter here: sticky ruler + playhead handle need
                // a clean scrollport. will-change:scroll-position alone is fine.
                willChange: "scroll-position",
                // Kill macOS rubber-band past the content end -- user could
                // pull the timeline into empty space past the last sample.
                overscrollBehavior: "none",
              }}
              onScroll={onScrollSync}
            >
              <div
                ref={timelineBodyRef}
                className="relative flex min-h-0 flex-col"
                style={{
                  width: contentWidth,
                  minHeight: "100%",
                  // No translateZ(0): any transform on this node breaks
                  // position:sticky for the ruler and playhead handle.
                }}
              >
                {/* Behind the ruler (z-20) and the lanes, above their
                  backgrounds -- it shades the arrangement without hiding the
                  bar numbers that say where you are out here. */}
                <OutOfBoundsOverlay
                  startPx={projectWidth}
                  widthPx={trailingSlackPx}
                />
                <SongRulerHeader
                  songs={songs}
                  songOffsets={songOffsets}
                  songLengths={songLengths}
                  songIndex={state.songIndex}
                  pxPerSec={pxPerSec}
                  contentWidth={contentWidth}
                  scrollState={scrollState}
                  playheadHandleRef={playheadHandleRef}
                  cycle={cycle}
                  songContentLengths={songContentLengths}
                  songEndDrag={songEndDrag}
                  onSongEndDrag={handleSongEndDrag}
                  onSongEndCommit={handleSongEndCommit}
                  snapToGrid={snapToGrid}
                  onCycleToggle={toggleCycle}
                  onCycleSetRange={setCycleRange}
                  onCycleToggleSkip={toggleCycleSkip}
                  onCycleDragEnd={commitCycleDrag}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancelOrLost}
                />

                {/* 1.5. Section Marker Lane -- structural markers per song (Intro/Verse/Chorus/...) */}
                <SectionMarkerLane
                  songs={songs}
                  songOffsets={songOffsets}
                  songLengths={songLengths}
                  pxPerSec={pxPerSec}
                  contentWidth={contentWidth}
                  readOnly={readOnly}
                  snapToGrid={snapToGrid}
                  cycle={cycle}
                  getPlayheadAbsoluteSec={getLivePlayheadAbsolute}
                  onCycleFromSection={(songIndex, leftSec, rightSec) => {
                    // Song section span (Intro/Verse/…), not an audio region.
                    // Rebinds the single project cycle to this song.
                    setCycleRange(leftSec, rightSec, {
                      activate: true,
                      songIndex,
                      songLength: songLengths[songIndex] ?? 0,
                    });
                  }}
                />

                <EventMarkerLane
                  songs={songs}
                  songOffsets={songOffsets}
                  pxPerSec={pxPerSec}
                  contentWidth={contentWidth}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancelOrLost}
                />

                {/* 2.5. Cross-mode hint strip: Audio mode shows dimmed light
                  content (no click targets), Light mode shows a dimmed audio
                  waveform reference. The opposite mode's content, one strip
                  per mode. */}
                {effectiveViewMode === "audio" ? (
                  hasLightContent && (
                    <LightHintStrip
                      songs={songs}
                      songOffsets={songOffsets}
                      songLengths={songLengths}
                      pxPerSec={pxPerSec}
                      scrollState={scrollState}
                      contentWidth={contentWidth}
                      height={LIGHT_HINT_HEIGHT}
                      trackColor={lightTrackColorForId}
                    />
                  )
                ) : (
                  <AudioHintStrip
                    state={state}
                    peaks={peaks}
                    allPeaks={allPeaks}
                    audioRows={rows.map((r) => ({
                      name: r.name,
                      color: r.color,
                    }))}
                    songs={songs}
                    songOffsets={songOffsets}
                    songLengths={songLengths}
                    pxPerSec={pxPerSec}
                    scrollState={scrollState}
                    contentWidth={contentWidth}
                  />
                )}

                {/* 3D preview moved to LightSidePanel — nothing to render here */}

                {/* 3. Track Waveforms & Grid Container -- one row per canonical track name, one segment per song */}
                <div
                  ref={tracksOriginRef}
                  className="relative flex-1 touch-none select-none min-h-30"
                  onPointerDown={onTracksPointerDown}
                  onPointerMove={onTracksPointerMove}
                  onPointerUp={onTracksPointerUp}
                  onPointerCancel={onTracksPointerCancel}
                  onLostPointerCapture={onTracksPointerCancel}
                  onDragOver={onTracksDragOver}
                  onDragLeave={onTracksDragLeave}
                  onDrop={onTracksDrop}
                >
                  {marqueeRect && (
                    <div
                      className="pointer-events-none absolute z-40 border border-accent/80 tint--soft"
                      style={{
                        left: marqueeRect.left,
                        top: marqueeRect.top,
                        width: marqueeRect.width,
                        height: marqueeRect.height,
                      }}
                    />
                  )}
                  {/* Dragged audio file -- fake region (waveform + duration),
                    no import until the drop fires (see onTracksDrop). */}
                  {audioDropFile && audioDropPos && (
                    <AudioDropGhost
                      name={audioDropFile.name}
                      duration={audioDropPreview?.duration ?? 0}
                      min={audioDropPreview?.min ?? []}
                      max={audioDropPreview?.max ?? []}
                      color={rows[audioDropPos.rowIndex]?.color ?? "#fff"}
                      leftPx={audioDropPos.startPx}
                      topPx={audioDropPos.rowIndex * laneHeightPx(verticalZoom)}
                      widthPx={Math.max(
                        8,
                        (audioDropPreview?.duration ?? 0) * pxPerSec,
                      )}
                      laneH={laneHeightPx(verticalZoom)}
                    />
                  )}
                  {midiDropName && audioDropPos && (
                    <div
                      className="pointer-events-none absolute z-40 flex items-center rounded-md border border-foreground/60 bg-surface/85 px-2 text-xs font-semibold text-foreground shadow-lg"
                      style={{
                        left: audioDropPos.startPx,
                        top: audioDropPos.rowIndex * laneHeightPx(verticalZoom) + 3,
                        height: Math.max(20, laneHeightPx(verticalZoom) - 6),
                      }}
                    >
                      MIDI · {midiDropName}
                    </div>
                  )}
                  {/* Beat/bar vertical grid canvas, per song (Viewport Sliced) */}
                  {songs.map((song, i) => (
                    <div
                      key={i}
                      className="absolute top-0 bottom-0"
                      style={{ left: Math.round(songOffsets[i] * pxPerSec) }}
                    >
                      <BeatGrid
                        pxPerSec={pxPerSec}
                        contentWidth={Math.max(
                          1,
                          Math.round(songLengths[i] * pxPerSec),
                        )}
                        scrollLeft={Math.max(
                          0,
                          scrollState.scrollLeft - songOffsets[i] * pxPerSec,
                        )}
                        viewportWidth={scrollState.viewportWidth}
                        songLength={songLengths[i]}
                        bpm={song.bpm}
                        tsNum={song.tsNum}
                      />
                    </div>
                  ))}

                  {effectiveViewMode === "light" ? (
                    <LightTrackLanes
                      lightEnabled={lightEnabled}
                      lightTracks={previewLightTracks}
                      lightTrackIds={lightTrackIds}
                      lightTrackColor={lightTrackColor}
                      lightTrueColors={lightTrueColors}
                      songs={songs}
                      songOffsets={songOffsets}
                      songLengths={songLengths}
                      pxPerSec={pxPerSec}
                      scrollState={scrollState}
                      verticalZoom={verticalZoom}
                      contentWidth={contentWidth}
                      readOnly={readOnly}
                      tool={effectiveTool}
                      toAbsSec={toAbsSec}
                      snapLocalSec={snapLocalSec}
                      snapToGrid={snapToGrid}
                      detentsForSong={detentsBySong}
                      selectedCueKeys={selectedCueKeys}
                      onSelectCue={selectCue}
                      onCopySelectedCues={copySelectedCue}
                      onDeleteSelectedCues={deleteSelectedCue}
                      lightCueDrag={lightCueDrag}
                      setLightCueDrag={setLightCueDrag}
                    />
                  ) : (
                    <AudioTrackLanes
                      writeGeomDraft={writeGeomDraft}
                      state={state}
                      rows={previewRows}
                      songs={songs}
                      songOffsets={songOffsets}
                      songLengths={songLengths}
                      pxPerSec={pxPerSec}
                      verticalZoom={verticalZoom}
                      contentWidth={contentWidth}
                      scrollState={scrollState}
                      peaks={peaks}
                      allPeaks={allPeaks}
                      regionGeomDraft={regionGeomDraft}
                      clearGeomDrafts={clearGeomDrafts}
                      regionDragKey={regionDragRef.current?.key ?? null}
                      selectedRegionKeys={selectedRegionKeys}
                      getRegionUi={getRegionUi}
                      gestureActive={gestureActive}
                      readOnly={readOnly}
                      tool={effectiveTool}
                      snapToGrid={snapToGrid}
                      selectRegion={selectRegion}
                      startRegionDrag={startRegionDrag}
                      onRegionContextMenu={setRegionContextMenu}
                      onOpenMidiRegion={onOpenMidiRegion}
                    />
                  )}
                </div>

                {/* 4. Lane needle (full content height). z below sticky ruler so
                  it doesn't cover song labels; the ruler-band segment is drawn
                  inside the sticky header (playheadHandleRef). */}
                <div
                  ref={playheadRef}
                  className="pointer-events-none absolute top-0 bottom-0 z-15 w-0"
                >
                  <div className="absolute top-0 bottom-0 left-0 w-[1.5px] -translate-x-1/2 bg-white shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
                </div>
              </div>
            </div>
          </div>

          {/* Right Audio Region inspector — the Audio-mode counterpart to
              LightSidePanel. Collapsible, and collapsed it is a rail; see
              SidePanelShell for why a manual collapse outranks the auto-open. */}
          {longImport.prompt && (
            <LongImportPrompt
              data={longImport.prompt}
              onResolve={longImport.resolve}
              onDismiss={longImport.dismiss}
            />
          )}
          {effectiveViewMode === "audio" && !readOnly && (
            <RegionSidePanel
              songs={state.songs}
              tracks={state.tracks}
              selectedTrackId={selectedTrackId}
              selectedRegionKeys={selectedRegionKeys}
              onClearSelection={() => setSelectedRegionKeys([])}
            />
          )}

          {/* Right Light Side Panel — shown in Light mode (editor only) */}
          {effectiveViewMode === "light" && !readOnly && (
            <LightSidePanel
              state={state}
              selection={sidePanelSelection}
              fixtures={lightFixtures}
              previewColors={previewColors}
              onClearSelection={() => {
                setCueSelection(null);
                setSidePanelTrackIndex(null);
              }}
            />
          )}
        </div>
      )}

      {regionContextMenu &&
        (selectedRegionKeys.length > 1 &&
        selectedRegionKeys.includes(regionContextMenu.selKey) ? (
          <SelectionContextMenu
            x={regionContextMenu.x}
            y={regionContextMenu.y}
            count={selectedRegionKeys.length}
            kind="region"
            onCopy={copySelectedRegions}
            onDelete={deleteSelectedRegions}
            onMuteToggle={() => {
              const anyUnmuted = selectedRegionKeys.some(
                (k) => !getRegionUi(k).muted,
              );
              for (const k of selectedRegionKeys) {
                setRegionUi(k, { muted: anyUnmuted });
              }
            }}
            muteLabel={
              selectedRegionKeys.some((k) => !getRegionUi(k).muted)
                ? "Mute selected"
                : "Unmute selected"
            }
            onClose={() => setRegionContextMenu(null)}
          />
        ) : (
          <RegionContextMenu
            menu={regionContextMenu}
            songs={songs}
            getRegionUi={getRegionUi}
            setRegionUi={setRegionUi}
            onCopy={copySelectedRegions}
            onCut={cutSelectedRegions}
            onPaste={() => void pasteClipboardRegions()}
            canPaste={hasClipboard("region")}
            onSplit={() => void splitSelectedAtPlayhead()}
            onClose={() => setRegionContextMenu(null)}
          />
        ))}
    </div>
  );
}
