import { useCallback, useEffect, useState } from "react";
import { PianoRollCanvas } from "./PianoRollCanvas";
import { PianoRollToolbar } from "./PianoRollToolbar";
import { applyLegato, applyOverlapTrim } from "./pianoRollModel";
import { snapPitchToScale } from "./scales";
import type {
  GridSnapValue,
  PianoRollBottomLane,
  PianoRollProps,
  PianoRollTool,
  ScaleMode,
} from "./types";

export function PianoRoll({
  region,
  companionRegions = [],
  track,
  tracks,
  onSelectTrack,
  regions,
  onSelectRegion,
  trackColor,
  playheadBeats,
  onNotesChange,
  onRegionChange,
  className = "",
}: PianoRollProps) {
  const [tool, setTool] = useState<PianoRollTool>("draw");
  const [snap, setSnap] = useState<GridSnapValue>(0.25); // 1/16 Beat default
  const [rootNote, setRootNote] = useState<number>(0); // C
  const [scaleMode, setScaleMode] = useState<ScaleMode>("minor");
  const [snapToScale, setSnapToScale] = useState<boolean>(false);
  const [showGhostNotes, setShowGhostNotes] = useState<boolean>(true);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<number>>(new Set());
  const [bottomLane, setBottomLane] = useState<PianoRollBottomLane>("velocity");

  const effectiveTrackColor = trackColor || "#0485f7";

  // Delete selected notes
  const handleDeleteSelected = useCallback(() => {
    if (selectedNoteIds.size === 0) return;
    const remaining = region.notes.filter((n) => !selectedNoteIds.has(n.id));
    onNotesChange(remaining);
    setSelectedNoteIds(new Set());
  }, [region.notes, selectedNoteIds, onNotesChange]);

  // Quantize selected notes (or all if none selected)
  const handleQuantize = useCallback(() => {
    if (snap <= 0) return;
    const targetIds = selectedNoteIds.size > 0 ? selectedNoteIds : new Set(region.notes.map((n) => n.id));

    const quantized = region.notes.map((note) => {
      if (!targetIds.has(note.id)) return note;
      const snappedStart = Math.max(0, Math.round(note.startBeats / snap) * snap);
      const snappedDuration = Math.max(snap, Math.round(note.durationBeats / snap) * snap);
      return {
        ...note,
        startBeats: snappedStart,
        durationBeats: snappedDuration,
      };
    });

    onNotesChange(quantized);
  }, [snap, selectedNoteIds, region.notes, onNotesChange]);

  // Humanize timing and velocity
  const handleHumanize = useCallback(() => {
    const targetIds = selectedNoteIds.size > 0 ? selectedNoteIds : new Set(region.notes.map((n) => n.id));

    const humanized = region.notes.map((note) => {
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

    onNotesChange(humanized);
  }, [selectedNoteIds, region.notes, onNotesChange]);

  // Transpose selected notes
  const handleTranspose = useCallback(
    (semitones: number) => {
      const targetIds = selectedNoteIds.size > 0 ? selectedNoteIds : new Set(region.notes.map((n) => n.id));

      const transposed = region.notes.map((note) => {
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

      onNotesChange(transposed);
    },
    [selectedNoteIds, region.notes, snapToScale, rootNote, scaleMode, onNotesChange],
  );

  // Force Legato
  const handleLegato = useCallback(() => {
    const updated = applyLegato(region.notes, selectedNoteIds);
    onNotesChange(updated);
  }, [region.notes, selectedNoteIds, onNotesChange]);

  // Overlap Trim
  const handleOverlapTrim = useCallback(() => {
    const updated = applyOverlapTrim(region.notes, selectedNoteIds);
    onNotesChange(updated);
  }, [region.notes, selectedNoteIds, onNotesChange]);

  // Keyboard hotkeys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          (activeEl as HTMLElement).isContentEditable)
      ) {
        return;
      }

      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        handleDeleteSelected();
      } else if (e.key === "v" || e.key === "V") {
        setTool("select");
      } else if (e.key === "b" || e.key === "B") {
        setTool("draw");
      } else if (e.key === "p" || e.key === "P") {
        setTool("brush");
      } else if (e.key === "s" || e.key === "S") {
        if (!e.metaKey && !e.ctrlKey) {
          setTool("slice");
        }
      } else if (e.key === "e" || e.key === "E") {
        setTool("erase");
      } else if (e.key === "q" || e.key === "Q") {
        e.preventDefault();
        handleQuantize();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        setSelectedNoteIds(new Set(region.notes.map((n) => n.id)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        handleTranspose(e.shiftKey ? 12 : 1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        handleTranspose(e.shiftKey ? -12 : -1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleDeleteSelected, handleQuantize, handleTranspose, region.notes]);

  return (
    <div className={`flex flex-col h-full w-full bg-background border border-default/30 rounded-lg overflow-hidden ${className}`}>
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
              <span className="font-semibold text-foreground truncate max-w-[120px]" title={track.name || track.id}>
                {track.name || track.id}
              </span>
              {tracks && onSelectTrack && (() => {
                const instrumentTracks = tracks.filter((tr) => tr.kind === "instrument" || tr.kind === "midi");
                if (instrumentTracks.length <= 1) return null;
                return (
                  <select
                    aria-label="Switch active track"
                    value={track.id}
                    onChange={(e) => onSelectTrack(e.target.value)}
                    className="bg-transparent text-[10px] text-foreground/60 hover:text-foreground cursor-pointer outline-none border-none ml-0.5"
                  >
                    {instrumentTracks.map((tr) => (
                      <option key={tr.id} value={tr.id} className="bg-background text-foreground">
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
                  <option key={r.id} value={r.id} className="bg-background text-foreground">
                    {r.name || r.id} ({r.notes.length} notes)
                  </option>
                ))}
              </select>
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
            {region.loop ? ` (Loop: ${region.loopLengthBeats}b)` : ""}
          </span>
        </div>
      </div>

      {/* Toolbar */}
      <PianoRollToolbar
        tool={tool}
        onToolChange={setTool}
        snap={snap}
        onSnapChange={setSnap}
        scaleMode={scaleMode}
        onScaleModeChange={setScaleMode}
        rootNote={rootNote}
        onRootNoteChange={setRootNote}
        snapToScale={snapToScale}
        onSnapToScaleChange={setSnapToScale}
        showGhostNotes={showGhostNotes}
        onShowGhostNotesChange={setShowGhostNotes}
        selectedCount={selectedNoteIds.size}
        onQuantize={handleQuantize}
        onHumanize={handleHumanize}
        onLegato={handleLegato}
        onOverlapTrim={handleOverlapTrim}
        onTranspose={handleTranspose}
        onDeleteSelected={handleDeleteSelected}
        bottomLane={bottomLane}
        onBottomLaneChange={setBottomLane}
      />

      {/* Canvas Viewport */}
      <div className="relative flex-1 min-h-0 w-full">
        <PianoRollCanvas
          region={region}
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
          onNotesChange={onNotesChange}
          onRegionChange={onRegionChange}
          bottomLane={bottomLane}
          playheadBeats={playheadBeats}
        />
      </div>
    </div>
  );
}
