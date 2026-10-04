/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PianoRollCanvas } from "@/screens/editor/pianoroll/components/PianoRollCanvas";
import { PianoRollToolbar } from "@/screens/editor/pianoroll/components/PianoRollToolbar";
import { getRegionActivePitches } from "@/lib/midi/activeMidiPitches";
import { Button } from "@/components/ui/Button";
import type { TimelineFollowMode } from "@/screens/editor/timeline/toolbar/logic/types";
import { useCycleState } from "@/screens/editor/timeline/cycle/hooks/useCycleState";
import { timelineHistory } from "@/lib/state/api";
import { subscribeHistoryBoundary } from "@/lib/state/historyNavigation";
import { getTrackColor } from "@/lib/theme";
import { useThemeVersion } from "@/hooks/useThemeVersion";
import { PianoRollHeader } from "@/screens/editor/pianoroll/components/PianoRollHeader";
import { pianoRollLaneOptions } from "@/screens/editor/pianoroll/toolbar/logic/options";
import {
  collectPianoRollControllerNumbers,
} from "@/screens/editor/pianoroll/logic/controllerLane";
import {
  collectPianoRollUmpControllerDimensions,
  collectPianoRollUmpControllerNumbers,
  collectPianoRollUmpControllerSourceIndices,
  hasPianoRollUmpPitchBend,
  isPianoRollUmpControllerLane,
} from "@/screens/editor/pianoroll/logic/umpControllerLane";
import { removePianoRollUmpControllerEvents } from "@/screens/editor/pianoroll/logic/umpControllerEditing";
import {
  shapeUmpControllerSelection,
  smoothUmpControllerSelection,
  umpControllerTransformAvailability,
} from "@/screens/editor/pianoroll/logic/umpControllerTransforms";
import { usePianoRollNoteActions } from "@/screens/editor/pianoroll/hooks/usePianoRollNoteActions";
import { usePianoRollUmpClipboardActions } from "@/screens/editor/pianoroll/hooks/usePianoRollUmpClipboardActions";
import { usePianoRollControllerEventSelection } from "@/screens/editor/pianoroll/hooks/usePianoRollControllerEventSelection";
import { usePianoRollCommands } from "@/screens/editor/pianoroll/hooks/usePianoRollCommands";
import { usePianoRollNoteDraft } from "@/screens/editor/pianoroll/hooks/usePianoRollNoteDraft";
import { usePianoRollMidiEventDraft } from "@/screens/editor/pianoroll/hooks/usePianoRollMidiEventDraft";
import { usePianoRollUmpEventDraft } from "@/screens/editor/pianoroll/hooks/usePianoRollUmpEventDraft";
import type {
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollControllerLaneMode,
  PianoRollProps,
  PianoRollTool,
  PianoRollViewport,
  ScaleMode,
} from "@/screens/editor/pianoroll/logic/types";

const LazyPianoRollUmpControllerEditor = lazy(async () => {
  const module = await import("@/screens/editor/pianoroll/components/PianoRollUmpControllerEditor");
  return { default: module.PianoRollUmpControllerEditor };
});

const DEFAULT_VIEWPORT: PianoRollViewport = {
  pixelsPerBeat: 80,
  pixelsPerPitch: 18,
  scrollBeats: 0,
  scrollPitch: 48, // Start around C3 (pitch 48)
  keyWidth: 54,
  velocityLaneHeight: 90,
};

export function PianoRoll({
  region,
  resetKey,
  companionRegions = [],
  activeMidiNotes = [],
  track,
  tracks,
  onSelectTrack,
  regions,
  onSelectRegion,
  selectedRegionIds,
  onToggleRegionVisible,
  trackColor,
  playheadBeats,
  getLivePlayheadBeats,
  timeSignatureNumerator = 4,
  isPlaying,
  onSeek,
  onNotesChange,
  onEventsChange,
  onUmpEventsChange,
  onRegionChange,
  canUndo = false,
  canRedo = false,
  undoLabel,
  redoLabel,
  onUndo,
  onRedo,
  projectCycle,
  projectSongIndex = 0,
  projectSong,
  projectSongLength = 0,
  className = "",
}: PianoRollProps) {
  useThemeVersion();
  const projectCycleState = useCycleState(projectSongIndex, projectSongLength, projectCycle);
  // Selection is the safe/default editing gesture. Drawing remains one key
  // press away (B), but opening a region must never make a plain click create
  // or resize notes when the user only meant to inspect one.
  const [tool, setTool] = useState<PianoRollTool>("select");
  const [snap, setSnap] = useState<GridSnapValue>(0.25); // 1/16 Beat default
  const [lastSnap, setLastSnap] = useState<GridSnapValue>(0.25);
  const [rootNote, setRootNote] = useState<number>(0); // C
  const [scaleMode, setScaleMode] = useState<ScaleMode>("minor");
  const [snapToScale, setSnapToScale] = useState<boolean>(false);
  const [showGhostNotes, setShowGhostNotes] = useState<boolean>(true);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<number>>(
    new Set(),
  );
  const [selectedUmpControllerEventIndices, setSelectedUmpControllerEventIndices] =
    useState<Set<number>>(new Set());
  const authoritativeNoteIdsRef = useRef({
    regionId: region.id,
    resetKey,
    ids: new Set(region.notes.map((note) => note.id)),
  });
  const { editableNotes, getEditableNotes, commitNotes, discardDraft,
    retryDraft, error: noteEditError, canRetry } = usePianoRollNoteDraft({
    regionId: region.id, resetKey, notes: region.notes, onNotesChange,
  });
  const regionEvents = useMemo(() => region.events ?? [], [region.events]);
  const { editableEvents, commitEvents, discardDraft: discardEventDraft,
    retryDraft: retryEventDraft, error: eventEditError,
    canRetry: canRetryEventDraft, status: eventEditStatus } = usePianoRollMidiEventDraft({
    regionId: region.id,
    resetKey,
    events: regionEvents,
    onEventsChange,
  });
  const regionUmpEvents = useMemo(() => region.umpEvents ?? [], [region.umpEvents]);
  const { editableEvents: editableUmpEvents, commitEvents: commitUmpEvents,
    discardDraft: discardUmpDraft, retryDraft: retryUmpDraft,
    error: umpEditError, canRetry: canRetryUmpDraft, status: umpEditStatus } = usePianoRollUmpEventDraft({
    regionId: region.id,
    resetKey,
    events: regionUmpEvents,
    onEventsChange: onUmpEventsChange,
  });
  const [umpEditorOpen, setUmpEditorOpen] = useState(false);
  const [bottomLane, setBottomLane] = useState<PianoRollBottomLane>("velocity");
  const [umpGroupFilter, setUmpGroupFilter] = useState<number | null>(null);
  const [umpChannelFilter, setUmpChannelFilter] = useState<number | null>(null);
  const [controllerLaneMode, setControllerLaneMode] = useState<PianoRollControllerLaneMode>("events");
  const umpDimensions = useMemo(
    () => collectPianoRollUmpControllerDimensions(
      editableUmpEvents,
      bottomLane,
      umpGroupFilter,
    ),
    [editableUmpEvents, bottomLane, umpGroupFilter],
  );
  const umpGroupOptions = useMemo(() => [
    { id: "all", label: "All groups" },
    ...[...umpDimensions.groups].sort((left, right) => left - right).map((group) => ({
      id: String(group),
      label: `Group ${group}`,
    })),
  ], [umpDimensions.groups]);
  const umpChannelOptions = useMemo(() => [
    { id: "all", label: "All channels" },
    ...[...umpDimensions.channels].sort((left, right) => left - right).map((channel) => ({
      id: String(channel),
      label: `Channel ${channel + 1}`,
    })),
  ], [umpDimensions.channels]);
  const bottomLaneOptions = useMemo(() => {
    return pianoRollLaneOptions(
      collectPianoRollControllerNumbers(regionEvents),
      bottomLane,
      collectPianoRollUmpControllerNumbers(editableUmpEvents),
      hasPianoRollUmpPitchBend(editableUmpEvents),
    );
  }, [regionEvents, editableUmpEvents, bottomLane]);
  const [loopLengthDraft, setLoopLengthDraft] = useState<string | null>(null);
  useEffect(() => subscribeHistoryBoundary(() => {
    setLoopLengthDraft(null);
  }), []);

  useEffect(() => setLoopLengthDraft(null), [region.id, region.loopLengthBeats, resetKey]);
  useEffect(() => {
    setUmpGroupFilter(null);
    setUmpChannelFilter(null);
    setSelectedUmpControllerEventIndices(new Set());
  }, [region.id, resetKey]);

  const umpSelectionSnapshotRef = useRef({ regionId: region.id, resetKey, events: editableUmpEvents });
  useEffect(() => {
    const previous = umpSelectionSnapshotRef.current;
    if (previous.regionId !== region.id || previous.resetKey !== resetKey
        || previous.events !== editableUmpEvents) {
      setSelectedUmpControllerEventIndices(new Set());
    }
    umpSelectionSnapshotRef.current = { regionId: region.id, resetKey, events: editableUmpEvents };
  }, [region.id, resetKey, editableUmpEvents]);

  useEffect(() => {
    if (umpGroupFilter !== null && !umpDimensions.groups.has(umpGroupFilter)) {
      setUmpGroupFilter(null);
      setUmpChannelFilter(null);
      return;
    }
    if (umpChannelFilter !== null && !umpDimensions.channels.has(umpChannelFilter))
      setUmpChannelFilter(null);
  }, [umpDimensions, umpGroupFilter, umpChannelFilter]);

  useEffect(() => {
    const available = new Set(region.notes.map((note) => note.id));
    const previous = authoritativeNoteIdsRef.current;
    if (previous.regionId !== region.id || previous.resetKey !== resetKey) {
      authoritativeNoteIdsRef.current = { regionId: region.id, resetKey, ids: available };
      setSelectedNoteIds(new Set());
      return;
    }

    // Prune only IDs that existed in Core's previous snapshot and have now
    // disappeared. Newly created optimistic notes are not authoritative yet;
    // don't clear their selection merely because the next state poll still
    // contains the pre-edit MIDI region.
    const removed = new Set([...previous.ids].filter((id) => !available.has(id)));
    authoritativeNoteIdsRef.current = { regionId: region.id, resetKey, ids: available };
    if (removed.size > 0) {
      setSelectedNoteIds((current) => {
        const next = new Set([...current].filter((id) => !removed.has(id)));
        return next.size === current.size ? current : next;
      });
    }
  }, [region.id, region.notes, resetKey]);

  const [viewport, setViewport] = useState<PianoRollViewport>(() => {
    try {
      const savedPpb = localStorage.getItem("resostage.pianoroll.pixelsPerBeat");
      const savedPpp = localStorage.getItem("resostage.pianoroll.pixelsPerPitch");
      return {
        ...DEFAULT_VIEWPORT,
        pixelsPerBeat: savedPpb ? Number(savedPpb) : DEFAULT_VIEWPORT.pixelsPerBeat,
        pixelsPerPitch: savedPpp ? Number(savedPpp) : DEFAULT_VIEWPORT.pixelsPerPitch,
      };
    } catch {
      return DEFAULT_VIEWPORT;
    }
  });

  const [followMode, setFollowMode] = useState<TimelineFollowMode>(() => {
    try {
      const saved = localStorage.getItem("resostage.pianoroll.followMode");
      if (saved === "off" || saved === "snap" || saved === "smooth") return saved;
    } catch {}
    return "snap";
  });
  const [catchOnPlay, setCatchOnPlay] = useState<boolean>(() => {
    try {
      return localStorage.getItem("resostage.pianoroll.catchOnPlay") !== "0";
    } catch {
      return true;
    }
  });
  const [catchOnSeek, setCatchOnSeek] = useState<boolean>(() => {
    try {
      return localStorage.getItem("resostage.pianoroll.catchOnSeek") !== "0";
    } catch {
      return true;
    }
  });

  const preferredFollowRef = useRef<Exclude<TimelineFollowMode, "off">>(
    followMode === "off" ? "snap" : followMode,
  );
  useEffect(() => {
    if (followMode !== "off") preferredFollowRef.current = followMode;
  }, [followMode]);

  useEffect(() => {
    try {
      localStorage.setItem("resostage.pianoroll.followMode", followMode);
    } catch {}
  }, [followMode]);

  useEffect(() => {
    try {
      localStorage.setItem("resostage.pianoroll.catchOnPlay", catchOnPlay ? "1" : "0");
    } catch {}
  }, [catchOnPlay]);

  useEffect(() => {
    try {
      localStorage.setItem("resostage.pianoroll.catchOnSeek", catchOnSeek ? "1" : "0");
    } catch {}
  }, [catchOnSeek]);

  const cycleFollowMode = useCallback(() => {
    setFollowMode((cur) => {
      const next = cur === "off" ? "snap" : cur === "snap" ? "smooth" : "off";
      return next;
    });
  }, []);

  const suspendFollowFromUserScroll = useCallback(() => {
    setFollowMode((m) => {
      if (m !== "off") preferredFollowRef.current = m;
      return "off";
    });
  }, []);

  const catchFollowOnPlay = useCallback(() => {
    if (!catchOnPlay) return;
    setFollowMode(preferredFollowRef.current);
  }, [catchOnPlay]);

  const catchFollowOnSeek = useCallback(() => {
    if (!catchOnSeek) return;
    setFollowMode(preferredFollowRef.current);
  }, [catchOnSeek]);

  const prevPlayingRef = useRef(isPlaying);
  useEffect(() => {
    if (isPlaying && !prevPlayingRef.current) {
      catchFollowOnPlay();
    }
    prevPlayingRef.current = isPlaying;
  }, [isPlaying, catchFollowOnPlay]);

  const handleSeek = useCallback(
    (beats: number) => {
      catchFollowOnSeek();
      onSeek?.(beats);
    },
    [catchFollowOnSeek, onSeek],
  );

  const trackColorIndex = tracks?.findIndex((candidate) => candidate.id === track?.id) ?? -1;
  const effectiveTrackColor = trackColorIndex >= 0
    ? getTrackColor(trackColorIndex)
    : trackColor || getTrackColor(0);
  const previewTrackId = track?.id ?? region.trackId;
  const activeMidiPitches = useMemo(
    () => new Set([
      ...getRegionActivePitches(
        region,
        companionRegions.filter((candidate) => candidate.trackId === previewTrackId),
        playheadBeats ?? -1,
        Boolean(isPlaying),
      ),
      ...activeMidiNotes
        .filter((note) => note.trackId === previewTrackId)
        .map((note) => note.pitch),
    ]),
    [
      region,
      companionRegions,
      previewTrackId,
      playheadBeats,
      isPlaying,
      activeMidiNotes,
    ],
  );
  const parsedLoopLength = loopLengthDraft === null ? null : Number(loopLengthDraft);
  const previewLoopLength = parsedLoopLength !== null && Number.isFinite(parsedLoopLength) && parsedLoopLength > 0
    ? parsedLoopLength
    : region.loopLengthBeats;
  const canvasRegion = useMemo(() => ({
    ...region,
    notes: editableNotes,
    events: editableEvents,
    umpEvents: editableUmpEvents,
    ...(loopLengthDraft !== null ? { loopLengthBeats: previewLoopLength } : {}),
  }), [region, editableNotes, editableEvents, editableUmpEvents, loopLengthDraft, previewLoopLength]);

  const noteActions = usePianoRollNoteActions({
    selectedNoteIds,
    setSelectedNoteIds,
    getEditableNotes,
    commitNotes,
    playheadBeats,
    region,
    snap: snap > 0 ? snap : lastSnap,
    snapToScale,
    rootNote,
    scaleMode,
  });
  const {
    handleDeleteSelected: handleDeleteSelectedNotes,
    handleCutSelected: handleCutSelectedNotes,
    handleCopySelected: handleCopySelectedNotes,
    handlePasteNotes: handlePasteNotesToNotes,
    handleSplitAtPlayhead,
    handleQuantize,
    handleHumanize,
    handleTranspose,
    handleNudge,
    handleLegato,
    handleOverlapTrim,
  } = noteActions;

  const hasEditableControllerLane = bottomLane !== "velocity"
    && !isPianoRollUmpControllerLane(bottomLane)
    && controllerLaneMode === "events" && Boolean(onEventsChange);
  const {
    selectedControllerEventIndices,
    setSelectedControllerEventIndices,
    handleDeleteSelected: handleDeleteMidi1Events,
    handleSelectAll: handleSelectMidi1All,
    canShapeSelectedControllerEvents: canShapeMidi1Events,
    handleSetSelectedCurve: handleSetSelectedMidi1Curve,
    handleSmoothSelectedEvents: handleSmoothSelectedMidi1Events,
  } = usePianoRollControllerEventSelection({
    regionId: region.id,
    resetKey,
    authoritativeEvents: regionEvents,
    editableEvents,
    bottomLane,
    controllerLaneMode,
    canEditControllerEvents: hasEditableControllerLane,
    commitEvents,
    selectedNoteIds,
    setSelectedNoteIds,
    getEditableNotes,
    deleteSelectedNotes: handleDeleteSelectedNotes,
  });
  const {
    handleCopy: handleCopyUmpEvents,
    handleCut: handleCutUmpEvents,
    handlePaste: handlePasteUmpEvents,
  } = usePianoRollUmpClipboardActions({
    enabled: Boolean(onUmpEventsChange),
    region,
    events: editableUmpEvents,
    selectedSourceIndices: selectedUmpControllerEventIndices,
    lane: bottomLane,
    groupFilter: umpGroupFilter,
    channelFilter: umpChannelFilter,
    playheadBeats,
    commitEvents: commitUmpEvents,
    setSelectedSourceIndices: setSelectedUmpControllerEventIndices,
  });
  const handleCopySelected = useCallback(() => {
    if (isPianoRollUmpControllerLane(bottomLane)
        && selectedUmpControllerEventIndices.size > 0) {
      handleCopyUmpEvents();
      return;
    }
    handleCopySelectedNotes();
  }, [bottomLane, selectedUmpControllerEventIndices, handleCopyUmpEvents,
    handleCopySelectedNotes]);
  const handleCutSelected = useCallback(() => {
    if (isPianoRollUmpControllerLane(bottomLane)
        && selectedUmpControllerEventIndices.size > 0) {
      handleCutUmpEvents();
      return;
    }
    handleCutSelectedNotes();
  }, [bottomLane, selectedUmpControllerEventIndices, handleCutUmpEvents,
    handleCutSelectedNotes]);
  const handlePasteNotes = useCallback(() => {
    if (isPianoRollUmpControllerLane(bottomLane)) {
      handlePasteUmpEvents();
      return;
    }
    handlePasteNotesToNotes();
  }, [bottomLane, handlePasteUmpEvents, handlePasteNotesToNotes]);
  const umpTransformAvailability = useMemo(() => (
    onUmpEventsChange && isPianoRollUmpControllerLane(bottomLane)
      ? umpControllerTransformAvailability(
        editableUmpEvents,
        [...selectedUmpControllerEventIndices],
        bottomLane,
        umpGroupFilter,
        umpChannelFilter,
      )
      : { curve: false, smooth: false }
  ), [onUmpEventsChange, bottomLane, editableUmpEvents, selectedUmpControllerEventIndices,
    umpGroupFilter, umpChannelFilter]);
  const isUmpControllerLane = isPianoRollUmpControllerLane(bottomLane);
  const canShapeSelectedControllerEvents = isUmpControllerLane
    ? umpTransformAvailability.curve
    : canShapeMidi1Events;
  const handleSetSelectedCurve = useCallback((curve: number) => {
    if (isUmpControllerLane) {
      if (!onUmpEventsChange) return;
      const next = shapeUmpControllerSelection(
        editableUmpEvents,
        [...selectedUmpControllerEventIndices],
        bottomLane,
        curve,
        umpGroupFilter,
        umpChannelFilter,
      );
      if (next) commitUmpEvents(next);
      return;
    }
    handleSetSelectedMidi1Curve(curve);
  }, [isUmpControllerLane, onUmpEventsChange, editableUmpEvents,
    selectedUmpControllerEventIndices, bottomLane, umpGroupFilter, umpChannelFilter,
    commitUmpEvents, handleSetSelectedMidi1Curve]);
  const handleSmoothSelectedEvents = useCallback(() => {
    if (isUmpControllerLane) {
      if (!onUmpEventsChange) return;
      const next = smoothUmpControllerSelection(
        editableUmpEvents,
        [...selectedUmpControllerEventIndices],
        bottomLane,
        umpGroupFilter,
        umpChannelFilter,
      );
      if (next) commitUmpEvents(next);
      return;
    }
    handleSmoothSelectedMidi1Events();
  }, [isUmpControllerLane, onUmpEventsChange, editableUmpEvents,
    selectedUmpControllerEventIndices, bottomLane, umpGroupFilter, umpChannelFilter,
    commitUmpEvents, handleSmoothSelectedMidi1Events]);
  useEffect(() => subscribeHistoryBoundary(() => {
    setSelectedControllerEventIndices(new Set());
    setSelectedUmpControllerEventIndices(new Set());
  }), [setSelectedControllerEventIndices]);

  const handleDeleteSelected = useCallback(() => {
    if (isPianoRollUmpControllerLane(bottomLane)
        && selectedUmpControllerEventIndices.size > 0) {
      const visibleIndices = new Set(collectPianoRollUmpControllerSourceIndices(
        editableUmpEvents, bottomLane, umpGroupFilter, umpChannelFilter,
      ));
      const next = removePianoRollUmpControllerEvents(
        editableUmpEvents,
        [...selectedUmpControllerEventIndices].filter((index) => visibleIndices.has(index)),
      );
      if (next) commitUmpEvents(next);
      setSelectedUmpControllerEventIndices(new Set());
      return;
    }
    handleDeleteMidi1Events();
  }, [bottomLane, selectedUmpControllerEventIndices, editableUmpEvents,
    umpGroupFilter, umpChannelFilter, commitUmpEvents, handleDeleteMidi1Events]);

  const handleSelectAll = useCallback(() => {
    if (isPianoRollUmpControllerLane(bottomLane)) {
      const indices = collectPianoRollUmpControllerSourceIndices(
        editableUmpEvents, bottomLane, umpGroupFilter, umpChannelFilter,
      );
      setSelectedNoteIds(new Set());
      setSelectedControllerEventIndices(new Set());
      setSelectedUmpControllerEventIndices(new Set(indices));
      return;
    }
    setSelectedUmpControllerEventIndices(new Set());
    handleSelectMidi1All();
  }, [bottomLane, editableUmpEvents, umpGroupFilter, umpChannelFilter,
    setSelectedControllerEventIndices, handleSelectMidi1All]);

  const handleUndo = useCallback(() => {
    discardDraft();
    if (onUndo) onUndo();
    else void timelineHistory.undo();
  }, [onUndo, discardDraft]);

  const handleRedo = useCallback(() => {
    discardDraft();
    if (onRedo) onRedo();
    else void timelineHistory.redo();
  }, [onRedo, discardDraft]);

  usePianoRollCommands({
    setTool,
    handleDeleteSelected,
    handleSelectAll,
    handleQuantize,
    handleCutSelected,
    handleCopySelected,
    handlePasteNotes,
    handleTranspose,
    handleNudge,
    handleUndo,
    handleRedo,
    handleSplitAtPlayhead,
  });

  return (
    <div
      data-pianoroll="true"
      className={`flex flex-col h-full w-full bg-background border border-default/30 rounded-lg overflow-hidden ${className}`}
    >
      <PianoRollHeader
        region={region}
        track={track}
        tracks={tracks}
        onSelectTrack={onSelectTrack}
        regions={regions}
        onSelectRegion={onSelectRegion}
        selectedRegionIds={selectedRegionIds}
        onToggleRegionVisible={onToggleRegionVisible}
        trackColorIndex={trackColorIndex}
        effectiveTrackColor={effectiveTrackColor}
      />

      {/* Toolbar */}
      <PianoRollToolbar
        tool={tool}
        onToolChange={setTool}
        snap={snap}
        onSnapChange={(value) => {
          setSnap(value);
          if (value > 0) setLastSnap(value);
          // Use the newly chosen division, not the previous render's snap.
          // Switching the grid without a selection is not a destructive edit.
          if (value > 0 && selectedNoteIds.size > 0) handleQuantize(value);
        }}
        snapEnabled={snap > 0}
        onToggleSnap={() => setSnap((current) => current > 0 ? 0 : lastSnap)}
        scaleMode={scaleMode}
        onScaleModeChange={setScaleMode}
        rootNote={rootNote}
        onRootNoteChange={setRootNote}
        snapToScale={snapToScale}
        onSnapToScaleChange={setSnapToScale}
        showGhostNotes={showGhostNotes}
        onShowGhostNotesChange={setShowGhostNotes}
        loopEnabled={region.loop}
        loopLengthBeats={loopLengthDraft ?? String(region.loopLengthBeats || region.durationBeats)}
        onLoopLengthBeatsChange={setLoopLengthDraft}
        onLoopLengthBeatsCommit={() => {
          if (loopLengthDraft === null) return;
          const nextLoopLength = Number(loopLengthDraft);
          if (!Number.isFinite(nextLoopLength) || nextLoopLength <= 0) {
            setLoopLengthDraft(null);
            return;
          }
          onRegionChange?.({
            ...region,
            loop: true,
            loopLengthBeats: nextLoopLength,
          });
          if (nextLoopLength === region.loopLengthBeats)
            setLoopLengthDraft(null);
        }}
        onLoopEnabledChange={(enabled) =>
          onRegionChange?.({
            ...region,
            loop: enabled,
            loopLengthBeats:
            (previewLoopLength ?? region.loopLengthBeats) > 0
                ? (previewLoopLength ?? region.loopLengthBeats)
                : region.durationBeats,
          })
        }
        selectedCount={selectedNoteIds.size}
        selectedControllerEventCount={hasEditableControllerLane
          ? selectedControllerEventIndices.size
          : isPianoRollUmpControllerLane(bottomLane) ? selectedUmpControllerEventIndices.size : 0}
        canShapeSelectedControllerEvents={canShapeSelectedControllerEvents}
        onControllerEventCurve={handleSetSelectedCurve}
        onSmoothSelectedControllerEvents={handleSmoothSelectedEvents}
        onQuantize={handleQuantize}
        onHumanize={handleHumanize}
        onLegato={handleLegato}
        onOverlapTrim={handleOverlapTrim}
        onTranspose={handleTranspose}
        onDeleteSelected={handleDeleteSelected}
        canUndo={canUndo}
        canRedo={canRedo}
        undoLabel={undoLabel}
        redoLabel={redoLabel}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onCopySelected={handleCopySelected}
        onCutSelected={handleCutSelected}
        onSplitAtPlayhead={handleSplitAtPlayhead}
        bottomLane={bottomLane}
        bottomLaneOptions={bottomLaneOptions}
        umpGroupOptions={isPianoRollUmpControllerLane(bottomLane) ? umpGroupOptions : undefined}
        umpChannelOptions={isPianoRollUmpControllerLane(bottomLane) ? umpChannelOptions : undefined}
        umpGroupFilter={umpGroupFilter}
        umpChannelFilter={umpChannelFilter}
        onUmpGroupFilterChange={(group) => {
          setUmpGroupFilter(group);
          setUmpChannelFilter(null);
          setSelectedUmpControllerEventIndices(new Set());
        }}
        onUmpChannelFilterChange={(channel) => {
          setUmpChannelFilter(channel);
          setSelectedUmpControllerEventIndices(new Set());
        }}
        onEditUmpEvents={onUmpEventsChange ? () => setUmpEditorOpen(true) : undefined}
        onBottomLaneChange={(lane) => {
          setBottomLane(lane);
          setUmpGroupFilter(null);
          setUmpChannelFilter(null);
          setSelectedUmpControllerEventIndices(new Set());
          if (isPianoRollUmpControllerLane(lane)) setControllerLaneMode("events");
        }}
        controllerLaneMode={controllerLaneMode}
        onControllerLaneModeChange={setControllerLaneMode}
        pixelsPerBeat={viewport.pixelsPerBeat}
        onPixelsPerBeatChange={(ppb) => {
          setViewport((v) => ({ ...v, pixelsPerBeat: ppb }));
          try {
            localStorage.setItem(
              "resostage.pianoroll.pixelsPerBeat",
              String(ppb),
            );
          } catch {}
        }}
        pixelsPerPitch={viewport.pixelsPerPitch}
        onPixelsPerPitchChange={(ppp) => {
          setViewport((v) => ({ ...v, pixelsPerPitch: ppp }));
          try {
            localStorage.setItem(
              "resostage.pianoroll.pixelsPerPitch",
              String(ppp),
            );
          } catch {}
        }}
        followMode={followMode}
        onCycleFollowMode={cycleFollowMode}
        catchOnPlay={catchOnPlay}
        onCatchOnPlayChange={setCatchOnPlay}
        catchOnSeek={catchOnSeek}
        onCatchOnSeekChange={setCatchOnSeek}
      />

      {umpEditorOpen && onUmpEventsChange && (
        <Suspense fallback={null}>
          <LazyPianoRollUmpControllerEditor
            isOpen
            onOpenChange={setUmpEditorOpen}
            events={editableUmpEvents}
            defaultBeat={region.clipOffsetBeats}
            onSave={commitUmpEvents}
          />
        </Suspense>
      )}

      {noteEditError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1">{noteEditError}</span>
          <Button size="sm" variant="secondary" isDisabled={!canRetry} onPress={retryDraft}>Retry</Button>
          <Button size="sm" variant="ghost" onPress={discardDraft}>Discard draft</Button>
        </div>
      )}

      {eventEditError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1">{eventEditError}</span>
          <Button size="sm" variant="secondary" isDisabled={!canRetryEventDraft} onPress={retryEventDraft}>Retry</Button>
          <Button size="sm" variant="ghost" onPress={discardEventDraft}>Discard draft</Button>
        </div>
      )}

      {umpEditError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1">{umpEditError}</span>
          <Button size="sm" variant="secondary" isDisabled={!canRetryUmpDraft} onPress={retryUmpDraft}>Retry</Button>
          <Button size="sm" variant="ghost" onPress={discardUmpDraft}>Discard draft</Button>
        </div>
      )}

      {/* Canvas Viewport */}
      <div className="relative flex-1 min-h-0 w-full">
        <PianoRollCanvas
          region={canvasRegion}
          companionRegions={companionRegions}
          trackColor={effectiveTrackColor}
          tool={tool}
          snap={snap}
          rootNote={rootNote}
          scaleMode={scaleMode}
          snapToScale={snapToScale}
          showGhostNotes={showGhostNotes}
          selectedNoteIds={selectedNoteIds}
          onSelectionChange={setSelectedNoteIds}
          selectedControllerEventIndices={selectedControllerEventIndices}
          onControllerEventSelectionChange={setSelectedControllerEventIndices}
          selectedUmpControllerEventIndices={selectedUmpControllerEventIndices}
          onUmpControllerEventSelectionChange={setSelectedUmpControllerEventIndices}
          onNotesChange={commitNotes}
          onRegionChange={onRegionChange}
          bottomLane={bottomLane}
          umpGroupFilter={umpGroupFilter}
          umpChannelFilter={umpChannelFilter}
          controllerLaneMode={controllerLaneMode}
          eventEditStatus={eventEditStatus}
          onEventsChange={onEventsChange ? commitEvents : undefined}
          umpEditStatus={umpEditStatus}
          onUmpEventsChange={onUmpEventsChange ? commitUmpEvents : undefined}
          playheadBeats={playheadBeats}
          getLivePlayheadBeats={getLivePlayheadBeats}
          activeMidiPitches={activeMidiPitches}
          timeSignatureNumerator={timeSignatureNumerator}
          isPlaying={isPlaying}
          onSeek={handleSeek}
          viewport={viewport}
          onViewportChange={setViewport}
          followMode={followMode}
          catchOnPlay={catchOnPlay}
          catchOnSeek={catchOnSeek}
          onSuspendFollow={suspendFollowFromUserScroll}
          projectCycle={projectCycleState.cycle}
          projectSong={projectSong}
          projectSongIndex={projectSongIndex}
          projectSongLength={projectSongLength}
          projectCycleOwner={projectCycleState.cycle.songIndex === projectSongIndex}
          onCycleToggleActive={projectCycleState.toggleActive}
          onCycleSetRange={projectCycleState.setRange}
          onCycleToggleSkip={projectCycleState.toggleSkip}
          onCycleDragEnd={projectCycleState.commitDrag}
        />
      </div>
      {loopLengthDraft !== null && (
        <div className="sr-only" aria-live="polite">
          Loop range preview: {previewLoopLength} beats. Confirm by leaving the field.
        </div>
      )}
    </div>
  );
}
