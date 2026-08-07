import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { builder, transport } from "../../lib/api";
import {
  useContinuousPlayhead,
  type CycleWrapRange,
} from "../../lib/optimistic";
import { isPositionVisible } from "../../lib/timelineVisibility";
import type {
  AllPeaksResponse,
  PeaksResponse,
  WebUiState,
} from "../../lib/types";
import {
  AudioHintStrip,
  LightHintStrip,
  LIGHT_HINT_HEIGHT,
} from "../light/LightTimeline";
import { LIGHT_COLORS } from "../light/lightColors";
import type { CueSelKey, LightCueDragState } from "../light/LightTimeline";
import { LightSidePanel } from "../light/LightSidePanel";
import type { LightSidePanelSelection } from "../light/LightSidePanel";
import { laneHeightPx } from "./laneDimensions";
import { AudioTrackLanes } from "./AudioTrackLanes";
import { AudioDropGhost } from "./AudioDropGhost";
import {
  audioDragInfo,
  audioFileDropEvent,
  entryToFile,
  loadAudioPreview,
} from "./audioDrop";
import { BeatGrid } from "./BeatGrid";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC } from "./constants";
import {
  duplicateCue,
  findCue,
  deleteCues,
  offsetCuesToPlayhead,
  pasteCues,
  splitCueAtPlayhead,
  type CueClipboardEntry,
} from "./cueEdit";
import { EventMarkerLane } from "./EventMarkerLane";
import { snapToGridSec } from "./geometry";
import { LightTrackLanes } from "./LightTrackLanes";
import {
  addRegionEntries,
  deleteSelectedRegions as deleteRegionsOp,
  offsetRegionsToPlayhead,
  resolveSelectedRegions,
  resolveSongLocal,
  selectRegionKeys,
  splitRegionsAtPlayhead,
} from "./regionEdit";
import {
  allRegionSelKeys,
  type RegionClipboardEntry,
  type RegionSelKey,
  type RegionUiState,
} from "./regionUtils";
import {
  RegionContextMenu,
  type RegionContextMenuState,
} from "./RegionContextMenu";
import {
  marqueeHitCues,
  marqueeHitRegions,
  normalizeMarquee,
  type MarqueeRect,
} from "./marqueeSelect";
import { buildRows } from "./rows";
import { SelectionContextMenu } from "./SelectionContextMenu";
import { SectionMarkerLane } from "./SectionMarkerLane";
import { SongRulerHeader } from "./SongRulerHeader";
import { TimelineSidebar } from "./TimelineSidebar";
import { TimelineToolbar } from "./TimelineToolbar";
import { ToastContainer, type Toast } from "./ToastContainer";
import { useCycleState } from "./useCycleState";
import { useRegionDrag } from "./useRegionDrag";
import { useSongLayout } from "./useSongLayout";
import { useTimelineKeyboard } from "./useTimelineKeyboard";
import { useTimelinePrefs } from "./useTimelinePrefs";

// ------- Timeline (continuous multi-song arrangement) -------------------

export function Timeline({
  state,
  peaks,
  allPeaks,
  pxPerSec,
  setPxPerSec,
  readOnly = false,
}: {
  state: WebUiState;
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
  /** Player: no track sidebar, no region trim/edit. */
  readOnly?: boolean;
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
  const [scrollState, setScrollState] = useState({
    scrollLeft: 0,
    viewportWidth: 1000,
  });

  // ZOOM-only flag feeding the playhead clock FREEZE below. Declared here so
  // the clock hook can read it; the setter lives with the other gesture
  // plumbing (see markZoomActiveRef).
  const [zoomActive, setZoomActive] = useState(false);

  // ONE continuous absolute clock for the whole project. Song-local time is
  // derived below -- never a second independent rAF loop keyed on songIndex
  // (that reset/fought across gapless boundaries and felt like two timelines).
  // `zoomActive` FREEZES the clock while a zoom gesture is in progress so the
  // playhead marker holds still ("автостоп времени при зуме"); it resumes
  // (and softly re-corrects toward the engine) the moment the zoom settles.
  // cycleWrapRef is filled after song layout (below) each render — rAF reads
  // it live so short loops wrap on the SPA without waiting for WS.
  const cycleWrapRef = useRef<CycleWrapRange | null>(null);
  const [playheadAbsoluteSec, setPlayheadAbsoluteSec, getLivePlayheadAbsolute] =
    useContinuousPlayhead(
      state.globalPlayheadSeconds,
      state.playing,
      state.projectName,
      zoomActive,
      dragging,
      cycleWrapRef,
    );
  // Live clock getter for the rAF follow/marker loop -- never go through the
  // React-state mirror (playheadAbsoluteSec), which can lag a commit behind
  // the rAF that advances the clock and made smooth-follow advance in steps.
  const getLivePlayheadAbsoluteRef = useRef(getLivePlayheadAbsolute);
  getLivePlayheadAbsoluteRef.current = getLivePlayheadAbsolute;

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
  } = useTimelinePrefs(readOnly);

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

  // Progressive rendering: track gesture activity for coarse→fine rendering
  const [gestureActive, setGestureActive] = useState(false);
  const gestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Plain ref, set SYNCHRONOUSLY in the same tick as the wheel/pinch handler
  // -- the smooth-follow rAF loop reads THIS, not a ref mirroring the
  // `gestureActive` React state below. That mirror only updates on the NEXT
  // render, and requestAnimationFrame callbacks are scheduled independently
  // of React's render/commit timing: if the loop's tick() ran in the single
  // frame between the wheel event firing and React's batched update
  // flushing, it would still see stale (false) and write scrollLeft for the
  // OLD playhead-anchor target at the exact moment applyZoomAt's own
  // zoom-focus effect was ALSO writing scrollLeft for the NEW zoom target --
  // a one-frame tug-of-war between the two, which is what made the playhead
  // visibly jump during a zoom gesture while autofollowing.
  const gestureActiveNowRef = useRef(false);
  const markGestureActiveRef = useRef(() => {
    gestureActiveNowRef.current = true;
    setGestureActive(true);
    if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
    gestureTimerRef.current = setTimeout(() => {
      gestureActiveNowRef.current = false;
      setGestureActive(false);
    }, 700);
  });
  // ZOOM-only flag feeding the playhead clock FREEZE: while the user is
  // zooming, the transport keeps playing but the timeline's clock must stand
  // still so the playhead marker doesn't creep left-right against the
  // zoom-focus anchor ("плейхед должен стоять на месте во время зума").
  // Deliberately NOT set by manual horizontal scrolling -- looking around must
  // never pause time, only a zoom gesture should.
  //
  // Each of the two flags gets its OWN timer: they fire together during a
  // pinch, and if they shared a single timer, markZoomActive's write would
  // overwrite (clear) the timer that resets gestureActiveNowRef, so a pinch
  // whose gestureend was lost would leave gestureActiveNowRef stuck true --
  // which permanently disabled auto-scroll in EVERY follow mode
  // ("автоскролл не пашет никакой теперь").
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markZoomActiveRef = useRef(() => {
    setZoomActive(true);
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = setTimeout(() => {
      setZoomActive(false);
    }, 700);
  });
  // Explicit end-of-gesture clear. The settle timer above is a fallback for
  // when a gesturechange burst stalls (a slow pinch can emit events more
  // sparsely than the timer window), but the browser ALSO fires gestureend /
  // touchend when the fingers lift -- clearing here makes the end exact
  // instead of waiting out the timer, and guarantees the zoom flag can't
  // outlive the fingers ("пинч периодически прерывается" was the timer
  // firing mid-gesture, flipping zoomActive off and unfreezing the clock
  // while fingers were still down).
  const endGestureRef = useRef(() => {
    gestureActiveNowRef.current = false;
    setGestureActive(false);
    setZoomActive(false);
    if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
    gestureTimerRef.current = null;
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = null;
  });
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
  // ("смотри такую вещь ... рывками и плейхед и таймлайн показывает"). Any
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
  const clipboardRegions = useRef<RegionClipboardEntry[]>([]);

  // Light-cue clipboard (parallel to clipboardRegions for audio regions).
  const clipboardCues = useRef<CueClipboardEntry[]>([]);

  const copySelectedCue = () => {
    const keys =
      selectedCueKeys.length > 0
        ? selectedCueKeys
        : cueSelection
          ? [cueSelection]
          : [];
    const entries: CueClipboardEntry[] = [];
    for (const k of keys) {
      const cue = findCue(state.songs, k);
      if (cue) entries.push({ ...cue, songIndex: k.songIndex });
    }
    if (entries.length === 0) return;
    clipboardCues.current = entries;
    showToast(
      entries.length === 1
        ? "Copied light cue"
        : `Copied ${entries.length} light cues`,
    );
  };

  const deleteSelectedCue = () => {
    const keys =
      selectedCueKeys.length > 0
        ? selectedCueKeys
        : cueSelection
          ? [cueSelection]
          : [];
    if (keys.length === 0) return;
    void deleteCues(keys);
    setCueSelection(null);
    setSelectedCueKeys([]);
    showToast(
      keys.length === 1 ? "Deleted light cue" : `Deleted ${keys.length} cues`,
    );
  };

  const selectCue = (
    sel: CueSelKey | null,
    mods?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ) => {
    if (sel === null) {
      setCueSelection(null);
      setSelectedCueKeys([]);
      return;
    }
    const additive = Boolean(mods?.metaKey || mods?.ctrlKey);
    setCueSelection(sel);
    setSelectedCueKeys((prev) => {
      if (additive) {
        const has = prev.some(
          (s) => s.songIndex === sel.songIndex && s.cueId === sel.cueId,
        );
        return has
          ? prev.filter(
              (s) => !(s.songIndex === sel.songIndex && s.cueId === sel.cueId),
            )
          : [...prev, sel];
      }
      return [sel];
    });
    // Selecting a cue clears audio region selection
    setSelectedRegionKeys([]);
  };

  const duplicateSelectedCue = async () => {
    if (!cueSelection) return;
    if (await duplicateCue(state.songs, cueSelection))
      showToast("Duplicated light cue");
  };

  const pasteClipboardCues = async () => {
    if (clipboardCues.current.length === 0) return;
    const { songIndex, localSeconds } = resolveSongLocal(
      songOffsets,
      songLengths,
      playheadAbsoluteSec,
    );
    const placed = offsetCuesToPlayhead(
      clipboardCues.current,
      songIndex,
      localSeconds,
    );
    const n = await pasteCues(placed);
    if (n) {
      showToast(`Pasted ${n} light cue(s) at playhead`);
      setSelectedCueKeys([]);
      setCueSelection(null);
      setSelectedRegionKeys([]);
    }
  };

  const splitSelectedCueAtPlayhead = async () => {
    if (!cueSelection) {
      showToast("Select a cue to trim");
      return;
    }
    const status = await splitCueAtPlayhead(
      state.songs,
      cueSelection,
      songOffsets,
      playheadAbsoluteSec,
    );
    if (status === "playhead-outside") {
      showToast("Playhead is not inside the selected cue");
      return;
    }
    if (status === "ok") {
      showToast("Split cue at playhead");
      setCueSelection(null);
    }
  };

  const selectRegion = (
    key: RegionSelKey,
    e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
  ) => {
    setSelectedRegionKeys(
      selectRegionKeys(key, e, selectedRegionKeys, state.songs),
    );
    setCueSelection(null);
    setSelectedCueKeys([]);
  };

  const copySelectedRegions = () => {
    clipboardRegions.current = resolveSelectedRegions(
      selectedRegionKeys,
      state.songs,
    );
    if (clipboardRegions.current.length)
      showToast(`Copied ${clipboardRegions.current.length} region(s)`);
  };

  const deleteSelectedRegions = () => {
    if (selectedRegionKeys.length === 0) return;
    deleteRegionsOp(selectedRegionKeys, state.songs);
    setSelectedRegionKeys([]);
    showToast("Deleted region(s)");
  };

  const duplicateSelectedRegions = async () => {
    const entries = resolveSelectedRegions(selectedRegionKeys, state.songs);
    await addRegionEntries(entries);
    if (entries.length) showToast(`Duplicated ${entries.length} region(s)`);
  };

  const pasteClipboardRegions = async () => {
    if (clipboardRegions.current.length === 0) return;
    const { songIndex, localSeconds } = resolveSongLocal(
      songOffsets,
      songLengths,
      playheadAbsoluteSec,
    );
    const placed = offsetRegionsToPlayhead(
      clipboardRegions.current,
      songIndex,
      localSeconds,
    );
    await addRegionEntries(placed);
    showToast(
      `Pasted ${clipboardRegions.current.length} region(s) at playhead`,
    );
    setSelectedRegionKeys([]);
    setSelectedCueKeys([]);
    setCueSelection(null);
  };

  // Drop selection entries that no longer exist (delete / project reload).
  useEffect(() => {
    const valid = new Set(allRegionSelKeys(state.songs));
    setSelectedRegionKeys((prev) => {
      const next = prev.filter((k) => valid.has(k));
      return next.length === prev.length ? prev : next;
    });
  }, [state.songs]);

  // Region UI state (mute); geometry is project-owned
  const [regions, setRegions] = useState<Map<RegionSelKey, RegionUiState>>(
    new Map(),
  );

  const [regionContextMenu, setRegionContextMenu] =
    useState<RegionContextMenuState | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const marqueeRef = useRef<{
    x0: number;
    y0: number;
    active: boolean;
    additive: boolean;
    /** Selection snapshot at marquee start (for shift/⌘ additive merge). */
    baseRegionKeys: RegionSelKey[];
    baseCueKeys: CueSelKey[];
  } | null>(null);
  // Filled after rows/song layout exist (see assignment below).
  const marqueeLiveRef = useRef<{
    effectiveViewMode: typeof effectiveViewMode;
    lightTrackIds: string[];
    songs: typeof state.songs;
    songOffsets: number[];
    songLengths: number[];
    pxPerSec: number;
    verticalZoom: number;
    rows: ReturnType<typeof buildRows>;
    tracks: typeof state.tracks;
  } | null>(null);

  const { regionGeomDraft, regionDragRef, regionDragCtxRef, startRegionDrag } =
    useRegionDrag({
      songs: state.songs,
      markGestureActive: () => markGestureActiveRef.current(),
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

  const { songLengths, songOffsets, totalLength } = useSongLayout(
    songs,
    allPeaks,
    peaks,
    state.songIndex,
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
  {
    const sc = state.cycle;
    let wrap: CycleWrapRange | null = null;
    if (
      sc?.active &&
      !sc.skip &&
      typeof sc.songIndex === "number" &&
      sc.songIndex >= 0
    ) {
      const lo = Math.min(sc.startSeconds, sc.endSeconds);
      const hi = Math.max(sc.startSeconds, sc.endSeconds);
      if (hi - lo >= 0.05) {
        const off = songOffsets[sc.songIndex] ?? 0;
        wrap = { loAbs: off + lo, hiAbs: off + hi };
      }
    }
    cycleWrapRef.current = wrap;
  }

  // Catch-follow when transport starts playing.
  const wasPlayingRef = useRef(state.playing);
  useEffect(() => {
    if (state.playing && !wasPlayingRef.current) catchFollowOnPlay();
    wasPlayingRef.current = state.playing;
  }, [state.playing, catchFollowOnPlay]);

  // Tool hotkeys (V/B/E) — plain keys only, never with mod keys (⌘C copy etc.).
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "v") setTool("pointer");
      else if (k === "b") setTool("pencil");
      else if (k === "e") setTool("eraser");
      // Scissors: bare "x" (Logic uses scissors tool; avoid bare "c" vs copy).
      else if (k === "x") setTool("scissors");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, setTool]);

  /** Split selected region(s) at the absolute playhead (Logic-style ⌘T). */
  const splitSelectedAtPlayhead = async () => {
    if (selectedRegionKeys.length === 0) {
      showToast("Select a region to trim");
      return;
    }
    const splitCount = await splitRegionsAtPlayhead(
      selectedRegionKeys,
      state.songs,
      songOffsets,
      songLengths,
      playheadAbsoluteSec,
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

  const contentWidth = Math.max(1, Math.round(totalLength * pxPerSec));

  const rows = useMemo(
    () => buildRows(state.tracks, songs),
    [state.tracks, songs],
  );

  // Drag & drop audio-file ghost preview (audio view only). While a file is
  // dragged over the lanes, AudioDropGhost shows a fake region -- waveform +
  // duration decoded from the local file -- but nothing is imported until the
  // drop actually fires (then builder.trackImportWav runs the real import).
  const audioDropFileRef = useRef<File | null>(null);
  const audioDropEntryResolvedRef = useRef<string | null>(null);
  const [audioDropFile, setAudioDropFile] = useState<{
    file: File;
    name: string;
  } | null>(null);
  const [audioDropPreview, setAudioDropPreview] = useState<{
    duration: number;
    min: number[];
    max: number[];
  } | null>(null);
  const [audioDropPos, setAudioDropPos] = useState<{
    rowIndex: number;
    trackIndex: number;
    songIndex: number;
    startPx: number;
  } | null>(null);

  const clearAudioDrop = () => {
    audioDropFileRef.current = null;
    audioDropEntryResolvedRef.current = null;
    setAudioDropFile(null);
    setAudioDropPreview(null);
    setAudioDropPos(null);
  };

  // Decode the dragged file once (cached in audioDrop.ts); preview fills in
  // as soon as it resolves.
  useEffect(() => {
    if (!audioDropFile) return;
    let cancelled = false;
    void loadAudioPreview(audioDropFile.file).then((p) => {
      if (!cancelled) setAudioDropPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [audioDropFile]);

  // Leaving audio view (or readOnly) dismisses any ghost.
  useEffect(() => {
    if (readOnly || effectiveViewMode !== "audio") clearAudioDrop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, effectiveViewMode]);

  const rowTrackIndexFor = (name: string) =>
    state.tracks.findIndex((t) => (t.name || t.id) === name);

  // Map a pointer position (relative to the tracks container) to the lane
  // row, song and clamped region-start pixel offset under it.
  const computeAudioDropPos = (x: number, y: number) => {
    const laneH = laneHeightPx(verticalZoom);
    const rowIndex = Math.max(
      0,
      Math.min(rows.length - 1, Math.floor(y / laneH)),
    );
    const trackIndex = rowTrackIndexFor(rows[rowIndex]?.name ?? "");
    // Orphan rows (no staged track) can't hold an import.
    if (trackIndex < 0) return null;
    let songIndex = 0;
    for (let i = 0; i < songOffsets.length; i++) {
      const start = songOffsets[i] * pxPerSec;
      if (x >= start && x < start + songLengths[i] * pxPerSec) {
        songIndex = i;
        break;
      }
    }
    const duration = audioDropPreview?.duration ?? 0;
    const durationPx = Math.max(8, duration * pxPerSec);
    const segStart = songOffsets[songIndex] * pxPerSec;
    const segEnd = segStart + Math.max(1, songLengths[songIndex] * pxPerSec);
    // Clamp the region start so the ghost stays inside the song segment.
    const maxStart = Math.max(segStart, segEnd - durationPx);
    return {
      rowIndex,
      trackIndex,
      songIndex,
      startPx: Math.max(segStart, Math.min(x, maxStart)),
    };
  };

  const onTracksDragOver = (e: React.DragEvent) => {
    if (readOnly || effectiveViewMode !== "audio") return;
    const info = audioDragInfo(e);
    // Not a file drag at all -- leave the browser default (no drop target).
    if (!info.anyFiles) return;
    // Accept the drag (drop allowed). On macOS the dragover phase carries no
    // File (audioDrop.ts docs the quirk) -- the audio check runs again on
    // drop, and the ghost only shows when we positively identified audio.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";

    if (info.audio) {
      // Grab the File for the preview: sync when available, else async via
      // the drop-entry (one resolution attempt per dragged filename).
      if (info.file) {
        if (audioDropFileRef.current !== info.file) {
          audioDropFileRef.current = info.file;
          setAudioDropFile({ file: info.file, name: info.name });
        }
      } else if (
        info.entry &&
        audioDropEntryResolvedRef.current !== info.name
      ) {
        audioDropEntryResolvedRef.current = info.name;
        void entryToFile(info.entry).then((f) => {
          if (f && audioDropFileRef.current !== f) {
            audioDropFileRef.current = f;
            setAudioDropFile({ file: f, name: f.name });
          }
        });
      }
    } else if (audioDropFile || audioDropPos) {
      // A file we couldn't identify as audio -- hide any stale ghost.
      clearAudioDrop();
    }

    const origin = tracksOriginRef.current;
    if (!origin) return;
    const rect = origin.getBoundingClientRect();
    // tracksOrigin lives inside the scrolled body -- getBoundingClientRect()
    // already shifts with scrollLeft (same rule as the marquee handlers).
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pos = computeAudioDropPos(x, y);
    setAudioDropPos(pos);
  };

  const onTracksDragLeave = (e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    clearAudioDrop();
  };

  const onTracksDrop = (e: React.DragEvent) => {
    if (readOnly || effectiveViewMode !== "audio") return;
    const file = audioFileDropEvent(e);
    if (!file) {
      clearAudioDrop();
      return;
    }
    e.preventDefault();
    const origin = tracksOriginRef.current;
    let pos = audioDropPos;
    // Drags that skipped the ghost (unidentified during dragover) still land
    // here with coordinates -- recompute so the import targets the right row.
    if (!pos && origin) {
      const rect = origin.getBoundingClientRect();
      pos = computeAudioDropPos(e.clientX - rect.left, e.clientY - rect.top);
    }
    clearAudioDrop();
    if (!pos) return;
    void builder.trackImportWav(pos.songIndex, pos.trackIndex, file);
  };

  // Keep window-level region-drag handlers on the latest layout/snap inputs.
  regionDragCtxRef.current = {
    pxPerSec,
    verticalZoom,
    snapToGrid,
    rows,
    tracks: state.tracks,
    songs,
  };

  // Light-mode derived data (Feature 6). Guarded with optional chaining so an
  // older WebUiState snapshot without the lighting fields still renders.
  const lightTracks = useMemo(
    () => state.lighting.tracks ?? [],
    [state.lighting.tracks],
  );
  const lightTrackIds = useMemo(
    () => lightTracks.map((t) => t.id),
    [lightTracks],
  );
  const lightFixtures = useMemo(
    () => state.lighting?.fixtures ?? [],
    [state.lighting?.fixtures],
  );
  const lightEnabled = Boolean(state.lighting?.enabled);
  const lightTrackColor = (index: number) =>
    LIGHT_COLORS[Math.max(0, index) % LIGHT_COLORS.length];
  const lightTrackColorForId = (trackId: string) =>
    lightTrackColor(lightTracks.findIndex((t) => t.id === trackId));
  const hasLightContent =
    lightEnabled &&
    (lightTracks.length > 0 ||
      songs.some((s) => (s.lightCues ?? []).length > 0));

  // Live marquee hit-test inputs (after layout deps exist).
  marqueeLiveRef.current = {
    effectiveViewMode,
    lightTrackIds,
    songs,
    songOffsets,
    songLengths,
    pxPerSec,
    verticalZoom,
    rows,
    tracks: state.tracks,
  };

  const applyMarqueeHits = (
    box: MarqueeRect,
    m: NonNullable<typeof marqueeRef.current>,
  ) => {
    const live = marqueeLiveRef.current;
    if (!live) return;
    const laneH = laneHeightPx(live.verticalZoom);
    if (live.effectiveViewMode === "light") {
      const hits = marqueeHitCues(
        box,
        live.lightTrackIds,
        live.songs,
        live.songOffsets,
        live.pxPerSec,
        laneH,
      );
      if (m.additive) {
        const map = new Map(
          m.baseCueKeys.map((s) => [`${s.songIndex}:${s.cueId}`, s] as const),
        );
        for (const h of hits) map.set(`${h.songIndex}:${h.cueId}`, h);
        const next = [...map.values()];
        setSelectedCueKeys(next);
        setCueSelection(next[next.length - 1] ?? null);
      } else {
        setSelectedCueKeys(hits);
        setCueSelection(hits[hits.length - 1] ?? null);
      }
      setSelectedRegionKeys([]);
    } else {
      const hits = marqueeHitRegions(
        box,
        live.rows,
        live.songs,
        live.songOffsets,
        live.songLengths,
        live.pxPerSec,
        laneH,
        live.tracks,
      );
      if (m.additive) {
        const set = new Set(m.baseRegionKeys);
        for (const h of hits) set.add(h);
        setSelectedRegionKeys([...set]);
      } else {
        setSelectedRegionKeys(hits);
      }
      setSelectedCueKeys([]);
      setCueSelection(null);
    }
  };

  // Live 3D stage colors come only from the core binary LED stream
  // (LightSidePanel). Do not re-resolve cues on the frontend.
  const previewColors = useMemo(
    () =>
      ({}) as Record<
        string,
        import("../../lib/lightCueInterpolation").LightCueValue
      >,
    [],
  );

  // Derived side-panel selection (after songs, lightTracks, cueSelection are defined)
  const sidePanelSelection: LightSidePanelSelection | null = (() => {
    if (effectiveViewMode !== "light") return null;
    if (cueSelection) {
      const song = songs[cueSelection.songIndex];
      const cue = song?.lightCues?.find((c) => c.id === cueSelection.cueId);
      if (cue) {
        const tIdx = lightTracks.findIndex((t) => t.id === cue.trackId);
        if (tIdx >= 0)
          return {
            type: "cue" as const,
            songIndex: cueSelection.songIndex,
            cue,
            trackIndex: tIdx,
            track: lightTracks[tIdx],
          };
      }
    }
    if (sidePanelTrackIndex !== null && lightTracks[sidePanelTrackIndex]) {
      return {
        type: "track" as const,
        trackIndex: sidePanelTrackIndex,
        track: lightTracks[sidePanelTrackIndex],
      };
    }
    return null;
  })();

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
    // the zoom ("пинчится не совсем точно там где нужно"). The old
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
    // per event, backing up the event queue ("дико лагает при зуме"). Every
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
  // wobbled the whole timeline ("колбасит не только плейхед но и таймлайн").
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
        setScrollState({
          scrollLeft: targetScrollLeft,
          viewportWidth: scroller.clientWidth || 1000,
        });
        pendingScrollLeftRef.current = null;
      } else {
        setScrollState({
          scrollLeft: scroller.scrollLeft,
          viewportWidth: scroller.clientWidth || 1000,
        });
      }
    }
  }, [pxPerSec]);

  const applyZoomAtRef = useRef(applyZoomAt);
  applyZoomAtRef.current = applyZoomAt;

  // Non-passive wheel & gesture event listeners attached to root container (always present)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.style.touchAction = "none";
    el.style.overscrollBehavior = "contain";

    let lastScale = 1.0;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        markGestureActiveRef.current();
        markZoomActiveRef.current();

        const base = 2;
        const speed = e.deltaMode === 1 ? 0.14 : 0.0065;
        let factor = Math.pow(base, -e.deltaY * speed * 4);
        factor = Math.max(0.2, Math.min(5, factor));

        applyZoomAtRef.current(pxPerSecRef.current * factor, e.clientX);
      }
    };

    const handleGestureStart = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      lastScale = 1.0;
      markGestureActiveRef.current();
      markZoomActiveRef.current();
    };

    const handleGestureChange = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      markGestureActiveRef.current();
      markZoomActiveRef.current();
      if (typeof e.scale === "number" && e.scale > 0) {
        const deltaScale = e.scale / lastScale;
        lastScale = e.scale;
        applyZoomAtRef.current(pxPerSecRef.current * deltaScale, e.clientX);
      }
    };

    const handleGestureEnd = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      lastScale = 1.0;
      endGestureRef.current();
    };

    el.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gesturestart", handleGestureStart as any, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gesturechange", handleGestureChange as any, {
      capture: true,
      passive: false,
    });
    el.addEventListener("gestureend", handleGestureEnd as any, {
      capture: true,
      passive: false,
    });

    return () => {
      el.removeEventListener("wheel", handleWheel, { capture: true });
      el.removeEventListener("gesturestart", handleGestureStart as any, {
        capture: true,
      });
      el.removeEventListener("gesturechange", handleGestureChange as any, {
        capture: true,
      });
      el.removeEventListener("gestureend", handleGestureEnd as any, {
        capture: true,
      });
    };
  }, []);

  // Maps an absolute (whole-timeline) second offset to whichever song
  // segment contains it, plus the position within that song.
  const resolveSong = (
    absSeconds: number,
  ): { songIndex: number; localSeconds: number } => {
    for (let i = 0; i < songs.length; i++) {
      const start = songOffsets[i];
      const end = start + songLengths[i];
      if (absSeconds < end || i === songs.length - 1)
        return { songIndex: i, localSeconds: Math.max(0, absSeconds - start) };
    }
    return { songIndex: -1, localSeconds: 0 };
  };

  const seekFromClientX = (clientX: number, commit = false) => {
    const bodyEl = timelineBodyRef.current;
    if (!bodyEl || songs.length === 0) return;
    // timelineBodyRef is the full-width content inside the scroller -- its
    // getBoundingClientRect().left already shifts with scrollLeft. Adding
    // scrollLeft again double-counted and scrub landed far from the cursor.
    const rect = bodyEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const absSeconds = Math.max(0, x / pxPerSecRef.current);
    const { songIndex, localSeconds } = resolveSong(absSeconds);
    if (songIndex < 0) return;

    const targetSong = songs[songIndex];
    const bpm = targetSong?.bpm ?? 120;
    const tsNum = targetSong?.tsNum ?? 4;
    const snappedLocal = snapToGridSec(
      localSeconds,
      pxPerSecRef.current,
      bpm,
      tsNum,
      snapToGrid,
    );

    // Clamp into the resolved song's authored length so we never seek past EOF.
    const songLen = songLengths[songIndex] ?? 0;
    const songStart = songOffsets[songIndex] ?? 0;
    const clampedLocal =
      songLen > 0
        ? Math.min(snappedLocal, Math.max(0, songLen - 0.01))
        : snappedLocal;
    const clampedAbs = songStart + clampedLocal;

    // Optimistic absolute needle moves immediately (one continuous timeline).
    // The commit lock only needs to bridge a real seek + one WS telemetry
    // turn now that useContinuousPlayhead no longer has a proximity-based
    // early release to race against -- see optimistic.ts's draggingRef doc.
    setPlayheadAbsoluteSec(clampedAbs, commit ? 800 : undefined);
    // Re-enable follow only when the seek lands *outside* the viewport.
    // Clicking/scrubbing within the already-visible range must not pan.
    if (commit) {
      const scroller = scrollRef.current;
      if (scroller) {
        const px = clampedAbs * pxPerSecRef.current;
        if (
          !isPositionVisible(px, scroller.scrollLeft, scroller.clientWidth || 0)
        ) {
          catchFollowOnSeek();
        }
      }
    }

    // Engine seeks only on commit (pointer up). Mid-drag same-song seeks used
    // to restage every 60ms and produced the "chirp then stop then play" glitch.
    if (!commit) return;

    if (songIndex !== state.songIndex) {
      void transport.seek(clampedLocal, songIndex);
      return;
    }
    void transport.seek(clampedLocal);
  };

  // Light-lane coordinate helpers (mirror seekFromClientX's math): absolute
  // project seconds from a clientX, and grid-snapped local seconds.
  const toAbsSec = (clientX: number) => {
    const bodyEl = timelineBodyRef.current;
    if (!bodyEl) return 0;
    const rect = bodyEl.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / pxPerSecRef.current);
  };
  const snapLocalSec = (songIndex: number, localSeconds: number) => {
    const song = songs[songIndex];
    if (!song) return localSeconds;
    return snapToGridSec(
      localSeconds,
      pxPerSecRef.current,
      song.bpm,
      song.tsNum ?? 4,
      snapToGrid,
    );
  };

  // Ruler / playhead-handle scrub. Mid-drag only moves the optimistic
  // needle; commit seeks the engine. Edge auto-scroll lives in the rAF
  // loop (dragging.current) so scrubbing past the viewport pans the
  // timeline like a DAW.
  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasSongs) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekFromClientX(e.clientX, false);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    if (e.buttons === 0) {
      dragging.current = false;
      seekFromClientX(e.clientX, true);
      return;
    }
    seekFromClientX(e.clientX, false);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    seekFromClientX(e.clientX, true);
  };
  const onPointerCancelOrLost = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    seekFromClientX(e.clientX, true);
  };
  // Empty track-lane gesture: click = seek + clear selection; drag = marquee.
  // Regions/cues stopPropagation so this only sees empty space.
  // While dragging, selection updates live (before mouse-up).
  const tracksOriginRef = useRef<HTMLDivElement>(null);
  const onTracksPointerDown = (e: React.PointerEvent) => {
    if (!hasSongs || readOnly || e.button !== 0) return;
    const origin = tracksOriginRef.current;
    if (!origin) return;
    const rect = origin.getBoundingClientRect();
    // tracksOrigin lives inside the scrolled body — getBoundingClientRect()
    // already shifts with scrollLeft. Adding scrollLeft again double-counts
    // (same bug seekFromClientX fixed) and draws marquee offset when panned.
    const x = e.clientX - rect.left;
    // y relative to tracks container (tracksOrigin is inside the scroll body).
    const y = e.clientY - rect.top;
    marqueeRef.current = {
      x0: x,
      y0: y,
      active: false,
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
      baseRegionKeys: [...selectedRegionKeys],
      baseCueKeys: [...selectedCueKeys],
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onTracksPointerMove = (e: React.PointerEvent) => {
    const m = marqueeRef.current;
    if (!m) return;
    const origin = tracksOriginRef.current;
    if (!origin) return;
    const rect = origin.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - m.x0;
    const dy = y - m.y0;
    if (!m.active && Math.hypot(dx, dy) < 6) return;
    m.active = true;
    const box = normalizeMarquee(m.x0, m.y0, x, y);
    setMarqueeRect(box);
    // Live highlight under the rubber-band before release.
    applyMarqueeHits(box, m);
  };
  const finishMarquee = (e: React.PointerEvent) => {
    const m = marqueeRef.current;
    marqueeRef.current = null;
    setMarqueeRect(null);
    if (!m) return;
    const origin = tracksOriginRef.current;
    if (!origin) return;
    const rect = origin.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (!m.active) {
      // Click empty lane: clear selection + seek.
      setSelectedRegionKeys([]);
      setSelectedCueKeys([]);
      setCueSelection(null);
      seekFromClientX(e.clientX, true);
      return;
    }
    // Final apply (matches last live frame; keeps additive baseline correct).
    applyMarqueeHits(normalizeMarquee(m.x0, m.y0, x, y), m);
  };
  const onTracksPointerUp = (e: React.PointerEvent) => {
    finishMarquee(e);
  };
  const onTracksPointerCancel = (_e: React.PointerEvent) => {
    marqueeRef.current = null;
    setMarqueeRect(null);
  };

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
    // it ("при вертикальном скролле стопается автоскролл").
    if (movedHorizontally) {
      markGestureActiveRef.current();
      // Manual pan while playing suspends follow; catch flags re-enable later.
      if (playingRef.current) suspendFollowFromUserScroll();
    }
    setScrollState({
      scrollLeft: left,
      viewportWidth: scroller.clientWidth,
    });
  };

  const keyboardActions = useMemo(
    () => ({
      copySelectedCue,
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
      pasteClipboardRegions,
      duplicateSelectedRegions,
      splitSelectedAtPlayhead,
      deleteSelectedRegions,
      setSelectedRegionKeys,
    }),
    // Handlers close over latest state; rebind when selection / mode shifts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      cueSelection,
      selectedCueKeys,
      selectedRegionKeys,
      state.songs,
      playheadAbsoluteSec,
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
  // every frame ("плейхед стал дико баганным"). Writing the style attribute
  // in the same tick as the scroll write makes the two atomic within a frame;
  // there is no React commit in between to desync them.
  //
  // The loop owns a single animated scroll position and glides it toward the
  // playhead-anchored target with a per-frame speed cap: normal follow eases
  // at ~25%/frame (filtering the small clock wobble), while big jumps --
  // song change, stop/full-stop reset, far seek -- PAN instead of teleporting
  // ("при переключении песен хай плавно скроллится к нужной песне", "время
  // стопилось якобы а потом оно с анимацией догоняло"). It runs ONCE (the
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
    let raf = 0;
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
          setScrollState({
            scrollLeft: engineScrollLeft,
            viewportWidth: viewWidth,
          });
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
            setScrollState({
              scrollLeft: scroller.scrollLeft,
              viewportWidth: viewWidth,
            });
          }
          revealScroll = null;
        }

        // Animated PANS (glide), unified for every follow mode and for
        // playing and stopped alike. Three triggers, all gliding instead of
        // teleporting ("глайд нужен не только в smooth", "не резко а плавно"):
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
        const jumped = songJumped || notYetVisible || (bigJump && outsideView);
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
              setScrollState({
                scrollLeft: revealLeft,
                viewportWidth: viewWidth,
              });
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
      // wobble over the content ("всё ещё колбасит плейхед"). When the
      // pending target is consumed, the DOM is consistent again and the loop
      // resumes writing the marker itself.
      if (pendingScrollLeftRef.current === null) {
        placePlayhead(displayPx);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

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
        <div className="flex h-full min-h-0 items-center justify-center text-sm text-foreground/40">
          No songs in this project
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {!readOnly && (
            <TimelineSidebar
              state={state}
              rows={rows}
              verticalZoom={verticalZoom}
              effectiveViewMode={effectiveViewMode}
              lightTracks={lightTracks}
              lightFixtures={lightFixtures}
              lightEnabled={lightEnabled}
              lightTrackColor={lightTrackColor}
              hasLightContent={hasLightContent}
              sidePanelTrackIndex={sidePanelTrackIndex}
              setSidePanelTrackIndex={setSidePanelTrackIndex}
              setCueSelection={() => selectCue(null)}
              sidebarContentRef={sidebarContentRef}
            />
          )}

          {/* Right Scrollable Timeline View (Horizontally & Vertically) */}
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-auto relative select-none cursor-col-resize focus:outline-none"
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
                className="relative flex-1 touch-none select-none min-h-[120px]"
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
                    className="pointer-events-none absolute z-40 border border-accent/80 bg-accent/15"
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
                    lightTracks={lightTracks}
                    lightTrackIds={lightTrackIds}
                    lightTrackColor={lightTrackColor}
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
                    selectedCueKeys={selectedCueKeys}
                    onSelectCue={selectCue}
                    onCopySelectedCues={copySelectedCue}
                    onDeleteSelectedCues={deleteSelectedCue}
                    lightCueDrag={lightCueDrag}
                    setLightCueDrag={setLightCueDrag}
                  />
                ) : (
                  <AudioTrackLanes
                    state={state}
                    rows={rows}
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
                    regionDragKey={regionDragRef.current?.key ?? null}
                    selectedRegionKeys={selectedRegionKeys}
                    getRegionUi={getRegionUi}
                    gestureActive={gestureActive}
                    readOnly={readOnly}
                    tool={effectiveTool}
                    selectRegion={selectRegion}
                    startRegionDrag={startRegionDrag}
                    onRegionContextMenu={setRegionContextMenu}
                  />
                )}
              </div>

              {/* 4. Lane needle (full content height). z below sticky ruler so
                  it doesn't cover song labels; the ruler-band segment is drawn
                  inside the sticky header (playheadHandleRef). */}
              <div
                ref={playheadRef}
                className="pointer-events-none absolute top-0 bottom-0 z-[15] w-0"
              >
                <div className="absolute top-0 bottom-0 left-0 w-[1.5px] -translate-x-1/2 bg-[#fff] shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
              </div>
            </div>
          </div>

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
            onClose={() => setRegionContextMenu(null)}
          />
        ))}
    </div>
  );
}
