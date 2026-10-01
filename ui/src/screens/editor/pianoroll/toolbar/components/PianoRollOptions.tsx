/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Popover, Separator } from "@heroui/react";
import { Layers, ListFilter, Music, Repeat2 } from "lucide-react";
import { Button, Select, Switch } from "@/components/ui";
import {
  PIANO_ROLL_ROOT_OPTIONS,
  PIANO_ROLL_SCALE_OPTIONS,
} from "@/screens/editor/pianoroll/toolbar/logic/options";
import type { PianoRollToolbarProps } from "@/screens/editor/pianoroll/toolbar/logic/types";
import type { ScaleMode } from "@/screens/editor/pianoroll/logic/types";

type PianoRollOptionsProps = Pick<PianoRollToolbarProps,
  "scaleMode" | "onScaleModeChange" | "rootNote" | "onRootNoteChange" |
  "snapToScale" | "onSnapToScaleChange" | "showGhostNotes" |
  "onShowGhostNotesChange" | "loopEnabled" | "onLoopEnabledChange" |
  "loopLengthBeats" | "onLoopLengthBeatsChange" | "onLoopLengthBeatsCommit" | "snap"
>;

/** Harmonic and region settings stay available without filling the main strip. */
export function PianoRollOptions(props: PianoRollOptionsProps) {
  return (
    <Popover>
      <Button size="sm" isIconOnly variant="tertiary" aria-label="Piano Roll options">
        <ListFilter size={13} />
      </Button>
      <Popover.Content className="w-72 border border-default/30 bg-background-secondary">
        <Popover.Dialog className="space-y-3 p-3 text-xs">
          <Popover.Heading className="text-xs font-semibold text-foreground">
            Piano Roll Options
          </Popover.Heading>
          <div className="flex items-center gap-2 text-foreground/60">
            <Music size={13} />
            <span>Scale</span>
          </div>
          <div className="flex gap-2">
            <Select
              size="sm"
              aria-label="Scale root"
              options={PIANO_ROLL_ROOT_OPTIONS}
              value={String(props.rootNote)}
              onChange={(value) => props.onRootNoteChange(Number(value))}
              className="w-20 shrink-0"
            />
            <Select
              size="sm"
              aria-label="Scale mode"
              options={PIANO_ROLL_SCALE_OPTIONS}
              value={props.scaleMode}
              onChange={(value) => props.onScaleModeChange(value as ScaleMode)}
              className="min-w-0 flex-1"
            />
          </div>
          <Switch size="sm" isSelected={props.snapToScale} onChange={props.onSnapToScaleChange}>
            <span>Snap Pitches to Scale</span>
          </Switch>
          <Separator />
          <Switch size="sm" isSelected={props.showGhostNotes} onChange={props.onShowGhostNotesChange}>
            <span className="flex items-center gap-2"><Layers size={13} />Ghost Notes</span>
          </Switch>
          {props.onLoopEnabledChange && (
            <>
              <Separator />
              <Switch size="sm" isSelected={Boolean(props.loopEnabled)} onChange={props.onLoopEnabledChange}>
                <span className="flex items-center gap-2"><Repeat2 size={13} />Repeat Region Pattern</span>
              </Switch>
              {props.loopEnabled && props.onLoopLengthBeatsChange && (
                <label className="flex items-center justify-between gap-3 text-foreground/60">
                  Pattern Length
                  <span className="flex items-center gap-1.5">
                    <input
                      aria-label="Pattern repeat length in beats"
                      type="number"
                      min={0.125}
                      step={props.snap > 0 ? props.snap : 0.25}
                      value={props.loopLengthBeats ?? "4"}
                      onChange={(event) => props.onLoopLengthBeatsChange?.(event.target.value)}
                      onBlur={props.onLoopLengthBeatsCommit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      className="w-16 rounded-md border border-default/30 bg-background px-2 py-1 text-right text-foreground outline-none focus:border-accent"
                    />
                    beats
                  </span>
                </label>
              )}
              <p className="text-[10px] leading-snug text-foreground/45">
                Repeats notes inside this region. The ruler controls the playback cycle for all tracks.
              </p>
            </>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
