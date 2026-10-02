/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { usePianoRollNoteActions } from "@/screens/editor/pianoroll/hooks/usePianoRollNoteActions";
import { usePianoRollCommands } from "@/screens/editor/pianoroll/hooks/usePianoRollCommands";
import { usePianoRollNoteDraft } from "@/screens/editor/pianoroll/hooks/usePianoRollNoteDraft";
import type {
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollProps,
  PianoRollTool,
  PianoRollViewport,
  ScaleMode,
} from "@/screens/editor/pianoroll/logic/types";

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
  const authoritativeNoteIdsRef = useRef({
    regionId: region.id,
    resetKey,
    ids: new Set(region.notes.map((note) => note.id)),
  });
  const { editableNotes, getEditableNotes, commitNotes, discardDraft,
    retryDraft, error: noteEditError, canRetry } = usePianoRollNoteDraft({
    regionId: region.id, resetKey, notes: region.notes, onNotesChange,
  });
  const [bottomLane, setBottomLane] = useState<PianoRollBottomLane>("velocity");
  const [loopLengthDraft, setLoopLengthDraft] = useState<string | null>(null);
  useEffect(() => subscribeHistoryBoundary(() => {
    setLoopLengthDraft(null);
  }), []);

  useEffect(() => setLoopLengthDraft(null), [region.id, region.loopLengthBeats, resetKey]);

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
    ...(loopLengthDraft !== null ? { loopLengthBeats: previewLoopLength } : {}),
  }), [region, editableNotes, loopLengthDraft, previewLoopLength]);

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
    handleDeleteSelected,
    handleCutSelected,
    handleCopySelected,
    handlePasteNotes,
    handleSplitAtPlayhead,
    handleQuantize,
    handleHumanize,
    handleTranspose,
    handleNudge,
    handleLegato,
    handleOverlapTrim,
  } = noteActions;

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
    handleQuantize,
    getEditableNotes,
    setSelectedNoteIds,
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
        onBottomLaneChange={setBottomLane}
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

      {noteEditError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1">{noteEditError}</span>
          <Button size="sm" variant="secondary" isDisabled={!canRetry} onPress={retryDraft}>Retry</Button>
          <Button size="sm" variant="ghost" onPress={discardDraft}>Discard draft</Button>
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
          onNotesChange={commitNotes}
          onRegionChange={onRegionChange}
          bottomLane={bottomLane}
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
