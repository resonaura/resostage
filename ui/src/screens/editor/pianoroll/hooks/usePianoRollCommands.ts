/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect } from "react";
import { hotkeyManager, HotkeyScope } from "@/lib/interaction/HotkeyManager";
import type { PianoRollTool } from "@/screens/editor/pianoroll/logic/types";

interface UsePianoRollCommandsOptions {
  setTool: (tool: PianoRollTool) => void;
  handleDeleteSelected: () => void;
  handleSelectAll: () => void;
  handleQuantize: () => void;
  handleCutSelected: () => void;
  handleCopySelected: () => void;
  handlePasteNotes: () => void;
  handleTranspose: (semitones: number) => void;
  handleNudge: (direction: -1 | 1) => void;
  handleUndo: () => void;
  handleRedo: () => void;
  handleSplitAtPlayhead: () => void;
}

/** Registers Piano Roll's fixed editor gestures in the shared hotkey manager. */
export function usePianoRollCommands({
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
      bind("undo", `${primary} + z`, handleUndo),
      bind("redo", `${primary} + shift + z`, handleRedo),
      ...(primary === "ctrl" ? [bind("redo-y", "ctrl + y", handleRedo)] : []),
      bind("split-at-playhead", `${primary} + t`, handleSplitAtPlayhead),
      bind("tool-select", "v", () => setTool("select")),
      bind("tool-draw", "b", () => setTool("draw")),
      bind("tool-brush", "p", () => setTool("brush")),
      bind("tool-slice", "s", () => setTool("slice")),
      bind("tool-erase", "e", () => setTool("erase")),
      bind("quantize", "q", handleQuantize),
      bind("select-all", `${primary} + a`, handleSelectAll),
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
    handleSelectAll,
    handleCutSelected,
    handleCopySelected,
    handlePasteNotes,
    handleQuantize,
    handleTranspose,
    handleNudge,
    handleUndo,
    handleRedo,
    handleSplitAtPlayhead,
    setTool,
  ]);
}
