/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Separator, Toolbar } from "@heroui/react";
import {
  Copy, Eraser, Magnet, MousePointer2, Paintbrush, Pencil, Redo2,
  Scissors, SlidersHorizontal, SquareSplitHorizontal, Trash2, Undo2,
} from "lucide-react";
import {
  Button, ButtonGroup, Select, ToggleButton, ToggleButtonGroup,
} from "@/components/ui";
import { PianoRollFollowControl } from "@/screens/editor/pianoroll/components/PianoRollFollowControl";
import { PianoRollZoomControl } from "@/screens/editor/pianoroll/components/PianoRollZoomControl";
import { PianoRollOptions } from "@/screens/editor/pianoroll/toolbar/components/PianoRollOptions";
import { PianoRollTransforms } from "@/screens/editor/pianoroll/toolbar/components/PianoRollTransforms";
import { PIANO_ROLL_LANE_OPTIONS, PIANO_ROLL_SNAP_OPTIONS } from "@/screens/editor/pianoroll/toolbar/logic/options";
import type { PianoRollToolbarProps } from "@/screens/editor/pianoroll/toolbar/logic/types";
import type { GridSnapValue, PianoRollBottomLane, PianoRollControllerLaneMode, PianoRollTool } from "@/screens/editor/pianoroll/logic/types";

const TOOLS = [
  { id: "select", label: "Select / Move (V)", icon: MousePointer2 },
  { id: "draw", label: "Draw / Pencil (B)", icon: Pencil },
  { id: "brush", label: "Brush / Repeating Notes (P)", icon: Paintbrush },
  { id: "slice", label: "Slice Notes (S)", icon: Scissors },
  { id: "erase", label: "Erase Notes (E)", icon: Eraser },
] as const;

/** Same grouping and design-system controls as the arrangement toolbar. */
export function PianoRollToolbar(props: PianoRollToolbarProps) {
  const selectionEmpty = props.selectedCount === 0;
  const snapEnabled = props.snapEnabled ?? props.snap > 0;

  return (
    <div className="z-20 flex shrink-0 flex-wrap items-center gap-2 border-b border-default/30 bg-background-secondary px-3 py-1.5 select-none">
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-foreground/40">
        Piano Roll
        {props.selectedCount > 0 && (
          <span className="ml-2 font-normal lowercase text-foreground/25">
            {props.selectedCount} selected
          </span>
        )}
      </span>
      <Toolbar aria-label="Piano Roll controls" className="ml-auto flex-wrap gap-1.5">
        {(props.onUndo || props.onRedo) && (
          <ButtonGroup size="sm" variant="tertiary">
            {props.onUndo && (
              <Button isIconOnly isDisabled={!props.canUndo} variant="default-soft"
                aria-label={props.undoLabel ? `Undo: ${props.undoLabel}` : "Undo"} onPress={props.onUndo}>
                <Undo2 size={13} />
              </Button>
            )}
            {props.onRedo && (
              <Button isIconOnly isDisabled={!props.canRedo} variant="default-soft"
                aria-label={props.redoLabel ? `Redo: ${props.redoLabel}` : "Redo"} onPress={props.onRedo}>
                {props.onUndo && <ButtonGroup.Separator />}
                <Redo2 size={13} />
              </Button>
            )}
          </ButtonGroup>
        )}
        <Separator orientation="vertical" />
        <ButtonGroup size="sm" variant="tertiary">
          {props.onCopySelected && (
            <Button isIconOnly isDisabled={selectionEmpty} variant="default-soft"
              aria-label="Copy selected notes" onPress={props.onCopySelected}>
              <Copy size={13} />
            </Button>
          )}
          <Button isIconOnly isDisabled={selectionEmpty} variant="default-soft"
            aria-label="Delete selected notes" onPress={props.onDeleteSelected}>
            {props.onCopySelected && <ButtonGroup.Separator />}
            <Trash2 size={13} />
          </Button>
          {props.onCutSelected && (
            <Button isIconOnly isDisabled={selectionEmpty} variant="default-soft"
              aria-label="Cut selected notes" onPress={props.onCutSelected}>
              <ButtonGroup.Separator /><Scissors size={13} />
            </Button>
          )}
          {props.onSplitAtPlayhead && (
            <Button
              isIconOnly
              isDisabled={props.selectedCount !== 1}
              variant="default-soft"
              aria-label="Split selected note at playhead"
              onPress={props.onSplitAtPlayhead}
            >
              <ButtonGroup.Separator /><SquareSplitHorizontal size={13} />
            </Button>
          )}
        </ButtonGroup>
        <Separator orientation="vertical" />
        <ToggleButtonGroup size="sm" aria-label="Piano Roll editing tools"
          selectionMode="single" disallowEmptySelection selectedKeys={[props.tool]}
          onSelectionChange={(keys) => {
            const tool = [...keys][0] as PianoRollTool | undefined;
            if (tool) props.onToolChange(tool);
          }}>
          {TOOLS.map(({ id, label, icon: Icon }, index) => (
            <ToggleButton key={id} id={id} isIconOnly aria-label={label}>
              {index > 0 && <ToggleButtonGroup.Separator />}<Icon size={13} />
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Separator orientation="vertical" />
        <div className="flex shrink-0 items-center gap-1.5">
          {props.onToggleSnap && (
            <ToggleButton size="sm" isIconOnly isSelected={snapEnabled}
              aria-label={snapEnabled ? "Snap to grid: ON" : "Snap to grid: OFF"} onChange={props.onToggleSnap}>
              <Magnet size={13} />
            </ToggleButton>
          )}
          <Select size="sm" fullWidth={false} aria-label="Grid snap division"
            value={String(props.snap)} options={PIANO_ROLL_SNAP_OPTIONS}
            onChange={(value) => props.onSnapChange(Number(value) as GridSnapValue)}
            className="w-20" />
        </div>
        <PianoRollTransforms onQuantize={props.onQuantize} onHumanize={props.onHumanize}
          onLegato={props.onLegato} onOverlapTrim={props.onOverlapTrim}
          onTranspose={props.onTranspose} snapEnabled={snapEnabled} />
        <PianoRollOptions {...props} />
        {props.onBottomLaneChange && (
          <>
            <Select size="sm" fullWidth={false} aria-label="Bottom lane"
              options={props.bottomLaneOptions ?? PIANO_ROLL_LANE_OPTIONS}
              value={props.bottomLane ?? "velocity"}
              onChange={(value) => props.onBottomLaneChange?.(value as PianoRollBottomLane)}
              startContent={<SlidersHorizontal size={13} />} className="w-36" />
            {props.bottomLane !== "velocity" && props.onControllerLaneModeChange && (
              <ToggleButtonGroup size="sm" aria-label="MIDI lane editing mode"
                selectionMode="single" disallowEmptySelection
                selectedKeys={[props.controllerLaneMode ?? "events"]}
                onSelectionChange={(keys) => {
                  const mode = [...keys][0] as PianoRollControllerLaneMode | undefined;
                  if (mode) props.onControllerLaneModeChange?.(mode);
                }}>
                <ToggleButton id="events" aria-label="Edit MIDI events">Events</ToggleButton>
                <ToggleButton id="automation" aria-label="Edit automation">Automation</ToggleButton>
              </ToggleButtonGroup>
            )}
          </>
        )}
        <Separator orientation="vertical" />
        <PianoRollFollowControl followMode={props.followMode} onCycleFollowMode={props.onCycleFollowMode}
          catchOnPlay={props.catchOnPlay} onCatchOnPlayChange={props.onCatchOnPlayChange}
          catchOnSeek={props.catchOnSeek} onCatchOnSeekChange={props.onCatchOnSeekChange} />
        {props.pixelsPerBeat !== undefined && props.onPixelsPerBeatChange &&
          props.pixelsPerPitch !== undefined && props.onPixelsPerPitchChange && (
          <PianoRollZoomControl pixelsPerBeat={props.pixelsPerBeat} onPixelsPerBeatChange={props.onPixelsPerBeatChange}
            pixelsPerPitch={props.pixelsPerPitch} onPixelsPerPitchChange={props.onPixelsPerPitchChange} />
        )}
      </Toolbar>
    </div>
  );
}
