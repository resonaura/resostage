/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect } from "react";
import { hotkeyManager, HotkeyScope } from "@/lib/interaction/HotkeyManager";
import type { MidiNoteRow } from "@/lib/state/types";
import type { PianoRollTool } from "@/screens/editor/pianoroll/logic/types";

interface UsePianoRollCommandsOptions {
  setTool: (tool: PianoRollTool) => void;
  handleDeleteSelected: () => void;
  handleQuantize: () => void;
  getEditableNotes: () => MidiNoteRow[];
  setSelectedNoteIds: (ids: Set<number>) => void;
  handleCutSelected: () => void;
  handleCopySelected: () => void;
  handlePasteNotes: () => void;
  handleTranspose: (semitones: number) => void;
  handleNudge: (direction: -1 | 1) => void;
}

/** Registers Piano Roll's fixed editor gestures in the shared hotkey manager. */
export function usePianoRollCommands({
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
}: UsePianoRollCommandsOptions): void {
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
      bind("copy-notes", `${primary} + c`, handleCopySelected),
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
  }, [
    handleDeleteSelected,
    handleCutSelected,
    handleCopySelected,
    handlePasteNotes,
    handleQuantize,
    handleTranspose,
    handleNudge,
    getEditableNotes,
    setSelectedNoteIds,
    setTool,
  ]);
}
