import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineFollowMode, TimelineViewMode } from "./TimelineToolbar";
import type { TimelineTool } from "./tools";

const FOLLOW_KEY = "resostage.timeline.followMode";
const VIEW_KEY = "resostage.timeline.viewMode";
const CATCH_PLAY_KEY = "resostage.timeline.catchOnPlay";
const XFADE_KEY = "resostage.timeline.crossfadeOnOverlap";
const CATCH_SEEK_KEY = "resostage.timeline.catchOnSeek";
const TOOL_KEY = "resostage.timeline.tool";

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === "0" || v === "false") return false;
    if (v === "1" || v === "true") return true;
  } catch {
    /* private mode */
  }
  return fallback;
}

function readFollowMode(): TimelineFollowMode {
  try {
    const saved = localStorage.getItem(FOLLOW_KEY);
    if (saved === "off" || saved === "snap" || saved === "smooth") return saved;
  } catch {
    /* private mode */
  }
  return "snap";
}

function readViewMode(): TimelineViewMode {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "audio" || saved === "light") return saved;
  } catch {
    /* private mode */
  }
  return "audio";
}

function readTool(): TimelineTool {
  try {
    const saved = localStorage.getItem(TOOL_KEY);
    if (
      saved === "pointer" ||
      saved === "pencil" ||
      saved === "eraser" ||
      saved === "scissors"
    )
      return saved;
  } catch {
    /* private mode */
  }
  return "pointer";
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* best-effort */
  }
}

/** Persisted timeline chrome prefs (follow, view, tool, catch flags). */
export function useTimelinePrefs(readOnly: boolean) {
  const [followMode, setFollowMode] =
    useState<TimelineFollowMode>(readFollowMode);
  const [viewMode, setViewMode] = useState<TimelineViewMode>(readViewMode);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [verticalZoom, setVerticalZoom] = useState(1.0);
  const [tool, setTool] = useState<TimelineTool>(readTool);
  const [catchOnPlay, setCatchOnPlay] = useState(() =>
    readBool(CATCH_PLAY_KEY, true),
  );
  const [catchOnSeek, setCatchOnSeek] = useState(() =>
    readBool(CATCH_SEEK_KEY, true),
  );
  // X-Fade drag mode. Off by default: it rewrites the neighbours' fades on
  // every drag that lands on one, which is only ever what you want when you
  // are deliberately assembling takes.
  const [crossfadeOnOverlap, setCrossfadeOnOverlap] = useState(() =>
    readBool(XFADE_KEY, false),
  );

  // Last non-off mode so we can restore after a manual-scroll suspend.
  const preferredFollowRef = useRef<Exclude<TimelineFollowMode, "off">>(
    followMode === "off" ? "snap" : followMode,
  );
  useEffect(() => {
    if (followMode !== "off") preferredFollowRef.current = followMode;
  }, [followMode]);

  useEffect(() => {
    persist(FOLLOW_KEY, followMode);
  }, [followMode]);
  useEffect(() => {
    persist(VIEW_KEY, viewMode);
  }, [viewMode]);
  useEffect(() => {
    persist(TOOL_KEY, tool);
  }, [tool]);
  useEffect(() => {
    persist(CATCH_PLAY_KEY, catchOnPlay ? "1" : "0");
  }, [catchOnPlay]);
  useEffect(() => {
    persist(XFADE_KEY, crossfadeOnOverlap ? "1" : "0");
  }, [crossfadeOnOverlap]);
  useEffect(() => {
    persist(CATCH_SEEK_KEY, catchOnSeek ? "1" : "0");
  }, [catchOnSeek]);

  const cycleFollowMode = useCallback(() => {
    setFollowMode((m) =>
      m === "off" ? "snap" : m === "snap" ? "smooth" : "off",
    );
  }, []);

  /** User scrolled the timeline while playing — suspend follow. */
  const suspendFollowFromUserScroll = useCallback(() => {
    setFollowMode((m) => {
      if (m !== "off") preferredFollowRef.current = m;
      return "off";
    });
  }, []);

  /** Playback started — re-enable follow if catchOnPlay. */
  const catchFollowOnPlay = useCallback(() => {
    if (!catchOnPlay) return;
    setFollowMode(preferredFollowRef.current);
  }, [catchOnPlay]);

  /** Playhead scrubbed/seeked — re-enable follow if catchOnSeek. */
  const catchFollowOnSeek = useCallback(() => {
    if (!catchOnSeek) return;
    setFollowMode(preferredFollowRef.current);
  }, [catchOnSeek]);

  const effectiveViewMode: TimelineViewMode = readOnly ? "audio" : viewMode;
  const effectiveTool: TimelineTool = readOnly ? "pointer" : tool;

  return {
    followMode,
    setFollowMode,
    cycleFollowMode,
    suspendFollowFromUserScroll,
    catchFollowOnPlay,
    catchFollowOnSeek,
    catchOnPlay,
    setCatchOnPlay,
    catchOnSeek,
    setCatchOnSeek,
    viewMode,
    setViewMode,
    effectiveViewMode,
    snapToGrid,
    setSnapToGrid,
    verticalZoom,
    setVerticalZoom,
    tool,
    setTool,
    effectiveTool,
    crossfadeOnOverlap,
    setCrossfadeOnOverlap,
  };
}
