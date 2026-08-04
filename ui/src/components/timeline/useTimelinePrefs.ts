import { useEffect, useState } from "react";
import type { TimelineFollowMode, TimelineViewMode } from "./TimelineToolbar";

const FOLLOW_KEY = "resostage.timeline.followMode";
const VIEW_KEY = "resostage.timeline.viewMode";

function readFollowMode(): TimelineFollowMode {
  try {
    const saved = localStorage.getItem(FOLLOW_KEY);
    if (saved === "off" || saved === "snap" || saved === "smooth") return saved;
  } catch {
    // localStorage unavailable (e.g. private mode)
  }
  return "snap";
}

function readViewMode(): TimelineViewMode {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "audio" || saved === "light") return saved;
  } catch {
    // localStorage unavailable
  }
  return "audio";
}

/** Persisted follow mode + audio/light view mode (editor only). */
export function useTimelinePrefs(readOnly: boolean) {
  const [followMode, setFollowMode] =
    useState<TimelineFollowMode>(readFollowMode);
  const [viewMode, setViewMode] = useState<TimelineViewMode>(readViewMode);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [verticalZoom, setVerticalZoom] = useState(1.0);

  useEffect(() => {
    try {
      localStorage.setItem(FOLLOW_KEY, followMode);
    } catch {
      // best-effort
    }
  }, [followMode]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, viewMode);
    } catch {
      // best-effort
    }
  }, [viewMode]);

  const cycleFollowMode = () =>
    setFollowMode((m) =>
      m === "off" ? "snap" : m === "snap" ? "smooth" : "off",
    );

  // Player is forced to audio.
  const effectiveViewMode: TimelineViewMode = readOnly ? "audio" : viewMode;

  return {
    followMode,
    setFollowMode,
    cycleFollowMode,
    viewMode,
    setViewMode,
    effectiveViewMode,
    snapToGrid,
    setSnapToGrid,
    verticalZoom,
    setVerticalZoom,
  };
}
