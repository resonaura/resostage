/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, type RefObject } from "react";
import { hotkeyManager, HotkeyScope } from "@/lib/interaction/HotkeyManager";

/** Scoped point editing must never fall through and delete selected regions. */
export function useAutomationKeyboard(id: string, surface: RefObject<HTMLDivElement | null>,
  readOnly: boolean, actions: { deleteSelectedPoints: () => void; selectAllPoints: () => void; clearSelection: () => void }) {
  useEffect(() => {
    if (readOnly) return;
    const mod = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "cmd" : "ctrl";
    const commands: Array<[string, string, () => void]> = [
      ["delete", "delete", actions.deleteSelectedPoints], ["backspace", "backspace", actions.deleteSelectedPoints],
      ["select-all", `${mod} + a`, actions.selectAllPoints], ["deselect", "escape", actions.clearSelection],
    ];
    const unregister = commands.map(([name, key, action]) => hotkeyManager.registerCommand(
      `automation.${id}.${name}`, key, { scope: HotkeyScope.Timeline, priority: 300 }, () => {
        if (document.activeElement !== surface.current) return false;
        action(); return true;
      }));
    return () => unregister.forEach((dispose) => dispose());
  }, [id, surface, readOnly, actions.deleteSelectedPoints, actions.selectAllPoints, actions.clearSelection]);
}
