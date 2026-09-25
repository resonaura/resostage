import {
  Eraser,
  Grid,
  Layers,
  MousePointer,
  Music,
  Pencil,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "../ui";
import {
  NOTE_NAMES,
  SCALE_LABELS,
} from "./scales";
import type { GridSnapValue, PianoRollTool, ScaleMode } from "./types";

interface PianoRollToolbarProps {
  tool: PianoRollTool;
  onToolChange: (tool: PianoRollTool) => void;
  snap: GridSnapValue;
  onSnapChange: (snap: GridSnapValue) => void;
  scaleMode: ScaleMode;
  onScaleModeChange: (mode: ScaleMode) => void;
  rootNote: number;
  onRootNoteChange: (root: number) => void;
  snapToScale: boolean;
  onSnapToScaleChange: (snap: boolean) => void;
  showGhostNotes: boolean;
  onShowGhostNotesChange: (show: boolean) => void;
  selectedCount: number;
  onQuantize: () => void;
  onHumanize: () => void;
  onTranspose: (semitones: number) => void;
  onDeleteSelected: () => void;
}

const SNAP_OPTIONS: { label: string; value: GridSnapValue }[] = [
  { label: "1 Bar", value: 4.0 },
  { label: "1/2", value: 2.0 },
  { label: "1/4", value: 1.0 },
  { label: "1/8", value: 0.5 },
  { label: "1/16", value: 0.25 },
  { label: "1/32", value: 0.125 },
  { label: "Off", value: 0 },
];

export function PianoRollToolbar({
  tool,
  onToolChange,
  snap,
  onSnapChange,
  scaleMode,
  onScaleModeChange,
  rootNote,
  onRootNoteChange,
  snapToScale,
  onSnapToScaleChange,
  showGhostNotes,
  onShowGhostNotesChange,
  selectedCount,
  onQuantize,
  onHumanize,
  onTranspose,
  onDeleteSelected,
}: PianoRollToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-default/30 bg-default/10 px-3 py-1.5 text-xs select-none">
      {/* Tool Selector */}
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant={tool === "select" ? "secondary" : "outline"}
          onPress={() => onToolChange("select")}
          aria-label="Select / Move tool (V)"
          className="h-7 px-2"
        >
          <MousePointer size={14} className="mr-1" />
          Select
        </Button>
        <Button
          size="sm"
          variant={tool === "draw" ? "secondary" : "outline"}
          onPress={() => onToolChange("draw")}
          aria-label="Draw / Pencil tool (B)"
          className="h-7 px-2"
        >
          <Pencil size={14} className="mr-1" />
          Draw
        </Button>
        <Button
          size="sm"
          variant={tool === "erase" ? "secondary" : "outline"}
          onPress={() => onToolChange("erase")}
          aria-label="Eraser tool (E)"
          className="h-7 px-2"
        >
          <Eraser size={14} className="mr-1" />
          Erase
        </Button>
      </div>

      {/* Snap & Grid */}
      <div className="flex items-center gap-1.5">
        <Grid size={14} className="text-foreground/50" />
        <span className="text-[11px] font-medium text-foreground/70">Snap:</span>
        <select
          value={snap}
          onChange={(e) => onSnapChange(Number(e.target.value) as GridSnapValue)}
          className="rounded border border-default/50 bg-default/20 px-2 py-0.5 text-xs text-foreground outline-none hover:border-default focus:border-accent"
        >
          {SNAP_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-background text-foreground">
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Scale & Harmonics */}
      <div className="flex items-center gap-1.5">
        <Music size={14} className="text-foreground/50" />
        <select
          value={rootNote}
          onChange={(e) => onRootNoteChange(Number(e.target.value))}
          className="rounded border border-default/50 bg-default/20 px-1.5 py-0.5 text-xs text-foreground outline-none hover:border-default focus:border-accent"
        >
          {NOTE_NAMES.map((name, idx) => (
            <option key={name} value={idx} className="bg-background text-foreground">
              {name}
            </option>
          ))}
        </select>
        <select
          value={scaleMode}
          onChange={(e) => onScaleModeChange(e.target.value as ScaleMode)}
          className="rounded border border-default/50 bg-default/20 px-2 py-0.5 text-xs text-foreground outline-none hover:border-default focus:border-accent"
        >
          {Object.entries(SCALE_LABELS).map(([k, label]) => (
            <option key={k} value={k} className="bg-background text-foreground">
              {label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant={snapToScale ? "secondary" : "outline"}
          onPress={() => onSnapToScaleChange(!snapToScale)}
          aria-label="Snap pitches to selected scale"
          className="h-7 px-2 text-[11px]"
        >
          Scale Snap
        </Button>
      </div>

      {/* Ghost Notes Toggle */}
      <Button
        size="sm"
        variant={showGhostNotes ? "secondary" : "outline"}
        onPress={() => onShowGhostNotesChange(!showGhostNotes)}
        aria-label="Display ghost notes from companion tracks"
        className="h-7 px-2 text-[11px]"
      >
        <Layers size={13} className="mr-1" />
        Ghost Notes
      </Button>

      {/* Actions */}
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          onPress={onQuantize}
          aria-label="Quantize notes to current grid snap"
          className="h-7 px-2 text-[11px]"
        >
          Quantize
        </Button>
        <Button
          size="sm"
          variant="outline"
          onPress={onHumanize}
          aria-label="Humanize timing and velocity"
          className="h-7 px-2 text-[11px]"
        >
          <Sparkles size={13} className="mr-1" />
          Humanize
        </Button>
        <div className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="outline"
            onPress={() => onTranspose(-12)}
            aria-label="Transpose -1 Octave"
            className="h-7 px-1.5 text-[11px]"
          >
            -8ve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onPress={() => onTranspose(12)}
            aria-label="Transpose +1 Octave"
            className="h-7 px-1.5 text-[11px]"
          >
            +8ve
          </Button>
        </div>
        {selectedCount > 0 && (
          <Button
            size="sm"
            variant="outline"
            onPress={onDeleteSelected}
            aria-label={`Delete ${selectedCount} selected note(s)`}
            className="h-7 px-2 text-danger hover:bg-danger/10"
          >
            <Trash2 size={13} className="mr-1" />
            Delete ({selectedCount})
          </Button>
        )}
      </div>
    </div>
  );
}
