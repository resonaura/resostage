import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PianoRollCanvas } from "./PianoRollCanvas";
import { PianoRollToolbar } from "./PianoRollToolbar";
import { hotkeyManager, HotkeyScope } from "../../../lib/interaction/HotkeyManager";
import { applyLegato, applyOverlapTrim, generateNoteId, sliceNote } from "../logic/pianoRollModel";
import { snapPitchToScale } from "../logic/scales";
import { getRegionActivePitches } from "../../midi/activeMidiPitches";
import type { MidiNoteRow } from "../../../lib/state/types";
import type { TimelineFollowMode } from "../../timeline/toolbar/logic/types";
import { useCycleState } from "../../timeline/cycle/hooks/useCycleState";
import { timelineHistory } from "../../../lib/state/api";
import { getTrackColor } from "../../timeline/constants";
import { TrackStateButtons } from "../../timeline/tracks/components/TrackStateButtons";
import { useThemeVersion } from "../../../hooks/useThemeVersion";
import type {
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollProps,
  PianoRollTool,
  PianoRollViewport,
  ScaleMode,
} from "../logic/types";

const DEFAULT_VIEWPORT: PianoRollViewport = {
  pixelsPerBeat: 80,
  pixelsPerPitch: 18,
  scrollBeats: 0,
  scrollPitch: 48, // Start around C3 (pitch 48)
  keyWidth: 54,
  velocityLaneHeight: 90,
};

function sameEditableNotes(left: MidiNoteRow[], right: MidiNoteRow[]): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((note) => [note.id, note]));
  return left.every((note) => {
    const actual = rightById.get(note.id);
    return actual !== undefined
      && actual.pitch === note.pitch
      && actual.startBeats === note.startBeats
      && actual.durationBeats === note.durationBeats
      && actual.velocity === note.velocity
      && actual.releaseVelocity === note.releaseVelocity
      && actual.probability === note.probability;
  });
}

export function PianoRoll({
  region,
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
    ids: new Set(region.notes.map((note) => note.id)),
  });
  const optimisticNotesRef = useRef<{
    regionId: string;
    notes: MidiNoteRow[];
  } | null>(null);
  const [noteClipboard, setNoteClipboard] = useState<MidiNoteRow[]>([]);
  const [bottomLane, setBottomLane] = useState<PianoRollBottomLane>("velocity");
  const [loopLengthDraft, setLoopLengthDraft] = useState<string | null>(null);

  useEffect(() => setLoopLengthDraft(null), [region.id, region.loopLengthBeats]);

  useEffect(() => {
    const available = new Set(region.notes.map((note) => note.id));
    const previous = authoritativeNoteIdsRef.current;
    if (previous.regionId !== region.id) {
      authoritativeNoteIdsRef.current = { regionId: region.id, ids: available };
      setSelectedNoteIds(new Set());
      return;
    }

    // Prune only IDs that existed in Core's previous snapshot and have now
    // disappeared. Newly created optimistic notes are not authoritative yet;
    // don't clear their selection merely because the next state poll still
    // contains the pre-edit MIDI region.
    const removed = new Set([...previous.ids].filter((id) => !available.has(id)));
    authoritativeNoteIdsRef.current = { regionId: region.id, ids: available };
    if (removed.size > 0) {
      setSelectedNoteIds((current) => {
        const next = new Set([...current].filter((id) => !removed.has(id)));
        return next.size === current.size ? current : next;
      });
    }
  }, [region.id, region.notes]);

  const getEditableNotes = useCallback(() => {
    const optimistic = optimisticNotesRef.current;
    return optimistic?.regionId === region.id ? optimistic.notes : region.notes;
  }, [region.id, region.notes]);

  const commitNotes = useCallback((notes: MidiNoteRow[]) => {
    optimisticNotesRef.current = { regionId: region.id, notes };
    onNotesChange(notes);
  }, [region.id, onNotesChange]);

  useEffect(() => {
    const optimistic = optimisticNotesRef.current;
    if (!optimistic) return;
    if (optimistic.regionId !== region.id
        || sameEditableNotes(optimistic.notes, region.notes))
      optimisticNotesRef.current = null;
  }, [region.id, region.notes]);

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
  const [catchOnPlay, setCatchOnPlay] = useState<boolean>(true);
  const [catchOnSeek, setCatchOnSeek] = useState<boolean>(true);

  const cycleFollowMode = useCallback(() => {
    setFollowMode((cur) => {
      const next = cur === "off" ? "snap" : cur === "snap" ? "smooth" : "off";
      try {
        localStorage.setItem("resostage.pianoroll.followMode", next);
      } catch {}
      return next;
    });
  }, []);

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
  const canvasRegion = loopLengthDraft === null
    ? region
    : { ...region, loopLengthBeats: previewLoopLength };

  // Delete selected notes
  const handleDeleteSelected = useCallback(() => {
    if (selectedNoteIds.size === 0) return;
    const remaining = getEditableNotes().filter((n) => !selectedNoteIds.has(n.id));
    commitNotes(remaining);
    setSelectedNoteIds(new Set());
  }, [getEditableNotes, selectedNoteIds, commitNotes]);

  const handleCutSelected = useCallback(() => {
    if (selectedNoteIds.size === 0) return;
    const notes = getEditableNotes();
    const copied = notes.filter((note) => selectedNoteIds.has(note.id));
    setNoteClipboard(copied.map((note) => ({ ...note })));
    commitNotes(notes.filter((note) => !selectedNoteIds.has(note.id)));
    setSelectedNoteIds(new Set());
  }, [getEditableNotes, selectedNoteIds, commitNotes]);

  const handlePasteNotes = useCallback(() => {
    if (noteClipboard.length === 0) return;
    const notes = getEditableNotes();
    const sourceStart = Math.min(...noteClipboard.map((note) => note.startBeats));
    const pasteStart = Math.max(0, playheadBeats ?? sourceStart);
    const pasted = noteClipboard.map((note) => ({
      ...note,
      id: generateNoteId(),
      startBeats: pasteStart + note.startBeats - sourceStart,
    }));
    commitNotes([...notes, ...pasted]);
    setSelectedNoteIds(new Set(pasted.map((note) => note.id)));
  }, [noteClipboard, playheadBeats, getEditableNotes, commitNotes]);

  const handleSplitAtPlayhead = useCallback(() => {
    const notes = getEditableNotes();
    const beat = Math.max(0, playheadBeats ?? 0);
    const targets = selectedNoteIds.size > 0
      ? notes.filter((note) => selectedNoteIds.has(note.id))
      : notes.filter((note) => beat > note.startBeats && beat < note.startBeats + note.durationBeats);
    if (targets.length === 0) return;
    const targetIds = new Set(targets.map((note) => note.id));
    const updated: MidiNoteRow[] = [];
    const newIds = new Set<number>();
    for (const note of notes) {
      if (!targetIds.has(note.id)) { updated.push(note); continue; }
      const split = sliceNote(note, beat);
      if (!split) { updated.push(note); continue; }
      updated.push(...split);
      newIds.add(split[0].id);
      newIds.add(split[1].id);
    }
    if (updated.length === notes.length) return;
    commitNotes(updated);
    setSelectedNoteIds(newIds);
  }, [playheadBeats, selectedNoteIds, getEditableNotes, commitNotes]);

  // Quantize selected notes (or all if none selected)
  const handleQuantize = useCallback(() => {
    if (snap <= 0) return;
    const notes = getEditableNotes();
    const targetIds =
      selectedNoteIds.size > 0
        ? selectedNoteIds
        : new Set(notes.map((n) => n.id));

    const quantized = notes.map((note) => {
      if (!targetIds.has(note.id)) return note;
      const snappedStart = Math.max(
        0,
        Math.round(note.startBeats / snap) * snap,
      );
      const snappedDuration = Math.max(
        snap,
        Math.round(note.durationBeats / snap) * snap,
      );
      return {
        ...note,
        startBeats: snappedStart,
        durationBeats: snappedDuration,
      };
    });

    commitNotes(quantized);
  }, [snap, selectedNoteIds, getEditableNotes, commitNotes]);

  // Humanize timing and velocity
  const handleHumanize = useCallback(() => {
    const notes = getEditableNotes();
    const targetIds =
      selectedNoteIds.size > 0
        ? selectedNoteIds
        : new Set(notes.map((n) => n.id));

    const humanized = notes.map((note) => {
      if (!targetIds.has(note.id)) return note;
      // Timing jitter: +/- 0.02 beats (~10ms @ 120bpm)
      const deltaBeat = (Math.random() - 0.5) * 0.04;
      // Velocity jitter: +/- 0.08
      const deltaVel = (Math.random() - 0.5) * 0.16;

      const newStart = Math.max(0, note.startBeats + deltaBeat);
      const newVel = Math.max(0.1, Math.min(1.0, note.velocity + deltaVel));

      return {
        ...note,
        startBeats: newStart,
        velocity: newVel,
      };
    });

    commitNotes(humanized);
  }, [selectedNoteIds, getEditableNotes, commitNotes]);

  // Transpose selected notes
  const handleTranspose = useCallback(
    (semitones: number) => {
      const notes = getEditableNotes();
      const targetIds =
        selectedNoteIds.size > 0
          ? selectedNoteIds
          : new Set(notes.map((n) => n.id));

      const transposed = notes.map((note) => {
        if (!targetIds.has(note.id)) return note;
        let newPitch = Math.max(0, Math.min(127, note.pitch + semitones));
        if (snapToScale) {
          newPitch = snapPitchToScale(newPitch, rootNote, scaleMode);
        }
        return {
          ...note,
          pitch: newPitch,
        };
      });

      commitNotes(transposed);
    },
    [
      selectedNoteIds,
      getEditableNotes,
      snapToScale,
      rootNote,
      scaleMode,
      commitNotes,
    ],
  );

  // Nudge follows the Piano Roll's own snap division (in beats). Like
  // transpose, an empty selection intentionally targets the whole region.
  const handleNudge = useCallback(
    (direction: -1 | 1) => {
      const notes = getEditableNotes();
      const targetIds = selectedNoteIds.size > 0
        ? selectedNoteIds
        : new Set(notes.map((note) => note.id));
      const amount = snap > 0 ? snap : 0.25;
      commitNotes(notes.map((note) => targetIds.has(note.id)
        ? { ...note, startBeats: Math.max(0, note.startBeats + direction * amount) }
        : note));
    },
    [selectedNoteIds, getEditableNotes, snap, commitNotes],
  );

  // Force Legato
  const handleLegato = useCallback(() => {
    const updated = applyLegato(getEditableNotes(), selectedNoteIds);
    commitNotes(updated);
  }, [getEditableNotes, selectedNoteIds, commitNotes]);

  // Overlap Trim
  const handleOverlapTrim = useCallback(() => {
    const updated = applyOverlapTrim(getEditableNotes(), selectedNoteIds);
    commitNotes(updated);
  }, [getEditableNotes, selectedNoteIds, commitNotes]);

  // Register Piano Roll commands with the shared application hotkey manager.
  useEffect(() => {
    const primary = /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
      ? "cmd"
      : "ctrl";
    const scope = HotkeyScope.PianoRoll;
    const bind = (id: string, key: string, handler: (event?: KeyboardEvent) => void) =>
      hotkeyManager.registerCommand(
        `piano-roll.${id}`,
        key,
        { scope, priority: 100 },
        handler,
      );
    const unregister = [
      bind("delete", "delete", handleDeleteSelected),
      bind("backspace", "backspace", handleDeleteSelected),
      bind("tool-select", "v", () => setTool("select")),
      bind("tool-draw", "b", () => setTool("draw")),
      bind("tool-brush", "p", () => setTool("brush")),
      bind("tool-slice", "s", () => setTool("slice")),
      bind("tool-erase", "e", () => setTool("erase")),
      bind("quantize", "q", handleQuantize),
      bind("select-all-notes", `${primary} + a`, () =>
        setSelectedNoteIds(new Set(getEditableNotes().map((note) => note.id))),
      ),
      bind("cut-notes", `${primary} + x`, handleCutSelected),
      bind("copy-notes", `${primary} + c`, () =>
        setNoteClipboard(
          getEditableNotes()
            .filter((note) => selectedNoteIds.has(note.id))
            .map((note) => ({ ...note })),
        ),
      ),
      bind("paste-notes", `${primary} + v`, handlePasteNotes),
      bind("transpose-up", "alt + up", (event) =>
        handleTranspose(event?.shiftKey ? 12 : 1),
      ),
      bind("transpose-octave-up", "alt + shift + up", () =>
        handleTranspose(12),
      ),
      bind("transpose-down", "alt + down", (event) =>
        handleTranspose(event?.shiftKey ? -12 : -1),
      ),
      bind("transpose-octave-down", "alt + shift + down", () =>
        handleTranspose(-12),
      ),
      bind("nudge-left", "alt + left", () => handleNudge(-1)),
      bind("nudge-left-shift", "alt + shift + left", () => handleNudge(-1)),
      bind("nudge-right", "alt + right", () => handleNudge(1)),
      bind("nudge-right-shift", "alt + shift + right", () => handleNudge(1)),
    ];
    return () => unregister.forEach((dispose) => dispose());
  }, [handleDeleteSelected, handleCutSelected, handlePasteNotes, handleQuantize, handleTranspose, handleNudge, getEditableNotes, selectedNoteIds, setTool]);

  return (
    <div
      data-pianoroll="true"
      className={`flex flex-col h-full w-full bg-background border border-default/30 rounded-lg overflow-hidden ${className}`}
    >
      {/* Header / Region & Track metadata */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-default/20 border-b border-default/30 text-xs font-semibold select-none">
        <div className="flex items-center gap-2 min-w-0">
          {/* Track linkage pill/badge */}
          {track ? (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-default/30 bg-surface/50">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0 shadow-sm"
                style={{ backgroundColor: effectiveTrackColor }}
              />
              <span
                className="font-semibold text-foreground truncate max-w-30"
                title={track.name || track.id}
              >
                {track.name || track.id}
              </span>
              {tracks &&
                onSelectTrack &&
                (() => {
                  const instrumentTracks = tracks.filter(
                    (tr) => tr.kind === "instrument" || tr.kind === "midi" || tr.kind === "externalMidi",
                  );
                  if (instrumentTracks.length <= 1) return null;
                  return (
                    <select
                      aria-label="Switch active track"
                      value={track.id}
                      onChange={(e) => onSelectTrack(e.target.value)}
                      className="bg-transparent text-[10px] text-foreground/60 hover:text-foreground cursor-pointer outline-none border-none ml-0.5"
                    >
                      {instrumentTracks.map((tr) => (
                        <option
                          key={tr.id}
                          value={tr.id}
                          className="bg-background text-foreground"
                        >
                          {tr.name || tr.id}
                        </option>
                      ))}
                    </select>
                  );
                })()}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-default/30 bg-surface/50">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500 shrink-0" />
              <span className="text-foreground/70">Unlinked</span>
            </div>
          )}

          {track && trackColorIndex >= 0 && (
            <TrackStateButtons track={track} index={trackColorIndex} focused compact />
          )}

          {/* Region selector or name */}
          {regions && regions.length > 1 && onSelectRegion ? (
            <div className="flex items-center gap-1">
              <span className="text-foreground/40">&middot;</span>
              <select
                aria-label="Select MIDI region"
                value={region.id}
                onChange={(e) => onSelectRegion(e.target.value)}
                className="bg-surface/60 border border-default/30 rounded px-1.5 py-0.5 text-xs text-foreground font-medium outline-none cursor-pointer hover:border-accent/40"
              >
                {regions.map((r) => (
                  <option
                    key={r.id}
                    value={r.id}
                    className="bg-background text-foreground"
                  >
                    {r.name || r.id} ({r.notes.length} notes)
                  </option>
                ))}
              </select>
              {selectedRegionIds && onToggleRegionVisible && (
                <details className="relative">
                  <summary className="cursor-pointer list-none rounded border border-default/30 bg-surface/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70 hover:border-accent/40">
                    {selectedRegionIds.length} visible
                  </summary>
                  <div className="absolute left-0 top-full z-50 mt-1 min-w-52 rounded-md border border-default/40 bg-background/95 p-2 shadow-xl backdrop-blur">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
                      Visible MIDI regions
                    </div>
                    {regions.map((candidate) => {
                      const checked = selectedRegionIds.includes(candidate.id);
                      const isPrimary = candidate.id === region.id;
                      return (
                        <label
                          key={candidate.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-default/15"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isPrimary}
                            onChange={(event) =>
                              onToggleRegionVisible(
                                candidate.id,
                                event.target.checked,
                              )
                            }
                          />
                          <span className="min-w-0 flex-1 truncate text-[11px]">
                            {candidate.name || candidate.id}
                          </span>
                          {isPrimary && (
                            <span className="text-[9px] font-semibold text-accent">
                              EDIT
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </details>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-foreground/40">&middot;</span>
              <span className="text-foreground font-semibold">
                {region.name || "MIDI Region"}
              </span>
            </div>
          )}

          <span className="text-[10px] font-normal text-foreground/50">
            ({region.notes.length} notes)
          </span>
        </div>

        <div className="flex items-center gap-2 text-[11px] font-normal text-foreground/60 shrink-0">
          <span>
            {region.durationBeats} beats
            {region.loop ? ` (Repeats every ${region.loopLengthBeats}b)` : ""}
          </span>
        </div>
      </div>

      {/* Toolbar */}
      <PianoRollToolbar
        tool={tool}
        onToolChange={setTool}
        snap={snap}
        onSnapChange={(value) => {
          setSnap(value);
          if (value > 0) setLastSnap(value);
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
        onUndo={onUndo ?? (() => void timelineHistory.undo())}
        onRedo={onRedo ?? (() => void timelineHistory.redo())}
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
          activeMidiPitches={activeMidiPitches}
          timeSignatureNumerator={timeSignatureNumerator}
          isPlaying={isPlaying}
          onSeek={onSeek}
          viewport={viewport}
          onViewportChange={setViewport}
          followMode={followMode}
          catchOnPlay={catchOnPlay}
          catchOnSeek={catchOnSeek}
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
