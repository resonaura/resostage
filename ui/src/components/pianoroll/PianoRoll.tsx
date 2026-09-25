import { useCallback, useEffect, useState } from "react";
import { PianoRollCanvas } from "./PianoRollCanvas";
import { PianoRollToolbar } from "./PianoRollToolbar";
import { snapPitchToScale } from "./scales";
import type { GridSnapValue, PianoRollProps, PianoRollTool, ScaleMode } from "./types";

export function PianoRoll({
  region,
  companionRegions = [],
  playheadBeats,
  onNotesChange,
  className = "",
}: PianoRollProps) {
  const [tool, setTool] = useState<PianoRollTool>("draw");
  const [snap, setSnap] = useState<GridSnapValue>(0.25); // 1/16 Beat default
  const [rootNote, setRootNote] = useState<number>(0); // C
  const [scaleMode, setScaleMode] = useState<ScaleMode>("minor");
  const [snapToScale, setSnapToScale] = useState<boolean>(false);
  const [showGhostNotes, setShowGhostNotes] = useState<boolean>(true);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<number>>(new Set());

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
      {/* Header / Region metadata */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-default/20 border-b border-default/30 text-xs font-semibold">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
          <span>Piano Roll: {region.name || "Untitled MIDI Region"}</span>
          <span className="text-[10px] font-normal text-foreground/50">
            ({region.notes.length} notes)
          </span>
        </div>
        <div className="text-[11px] font-normal text-foreground/60">
          Length: {region.durationBeats} beats {region.loop ? `(Loop: ${region.loopLengthBeats}b)` : ""}
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
        onTranspose={handleTranspose}
        onDeleteSelected={handleDeleteSelected}
      />

      {/* Canvas Viewport */}
      <div className="relative flex-1 min-h-0 w-full">
        <PianoRollCanvas
          region={region}
          companionRegions={companionRegions}
          tool={tool}
          snap={snap}
          rootNote={rootNote}
          scaleMode={scaleMode}
          snapToScale={snapToScale}
          showGhostNotes={showGhostNotes}
          selectedNoteIds={selectedNoteIds}
          onSelectionChange={setSelectedNoteIds}
          onNotesChange={onNotesChange}
          playheadBeats={playheadBeats}
        />
      </div>
    </div>
  );
}
