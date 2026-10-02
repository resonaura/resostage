/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, type RefObject } from "react";
import { hotkeyManager, HotkeyScope } from "@/lib/interaction/HotkeyManager";

/** Scoped point editing must never fall through and delete selected regions. */
export function useAutomationKeyboard(id: string, surface: RefObject<HTMLDivElement | null>,
  readOnly: boolean, actions: {
    deleteSelectedPoints: () => void;
    selectAllPoints: () => void;
    clearSelection: () => void;
    copySelectedPoints?: () => void;
    cutSelectedPoints?: () => void;
    pastePoints?: () => void;
    duplicateSelectedPoints?: () => void;
    onEditValue?: () => void;
  }) {
  useEffect(() => {
    if (readOnly) return;
    const mod = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "cmd" : "ctrl";
    const commands: Array<[string, string, () => void]> = [
      ["delete", "delete", actions.deleteSelectedPoints], ["backspace", "backspace", actions.deleteSelectedPoints],
      ["select-all", `${mod} + a`, actions.selectAllPoints], ["deselect", "escape", actions.clearSelection],
    ];
    if (actions.copySelectedPoints) {
      commands.push(["copy", `${mod} + c`, actions.copySelectedPoints]);
    }
    if (actions.cutSelectedPoints) {
      commands.push(["cut", `${mod} + x`, actions.cutSelectedPoints]);
    }
    if (actions.pastePoints) {
      commands.push(["paste", `${mod} + v`, actions.pastePoints]);
    }
    if (actions.duplicateSelectedPoints) {
      commands.push(["duplicate", `${mod} + d`, actions.duplicateSelectedPoints]);
    }
    if (actions.onEditValue) {
      commands.push(
        ["edit-value-return", "return", actions.onEditValue],
        ["edit-value-enter", "enter", actions.onEditValue],
      );
    }
    const unregister = commands.map(([name, key, action]) => hotkeyManager.registerCommand(
      `automation.${id}.${name}`, key, { scope: HotkeyScope.Timeline, priority: 300 }, () => {
        if (document.activeElement !== surface.current) return false;
        action(); return true;
      }));
    return () => unregister.forEach((dispose) => dispose());
  }, [
    id,
    surface,
    readOnly,
    actions.deleteSelectedPoints,
    actions.selectAllPoints,
    actions.clearSelection,
    actions.copySelectedPoints,
    actions.cutSelectedPoints,
    actions.pastePoints,
    actions.duplicateSelectedPoints,
    actions.onEditValue,
  ]);
}
