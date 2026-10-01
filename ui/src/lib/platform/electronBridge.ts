/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { resolveCssVar } from "@/lib/theme/cssColor";
import { IS_ELECTRON } from "@/lib/platform/electron";
import type { WebUiState } from "@/lib/state/types";

// Electron-only bridge to the shell's main process (electron/main.js).
//
// The shell owns the native menu bar and Touch Bar. It builds them once from
// GET /api/v1/ui/menu, but the *live* bits -- undo/redo enabled state +
// labels, the File > Open Recent submenu, the active Touch Bar tab, and the
// window title -- come from the same 30 Hz WebUiState this page receives.
// forwardMenuState() pushes just those fields over IPC, deduped so a 30 Hz
// snapshot stream only rebuilds the native menu when something actually
// changed.

interface ElectronMenuState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  uiTab: string;
  /**
   * The theme's accent, resolved to a hex.
   *
   * The main process paints the active Touch Bar button and has no way to
   * read a CSS custom property, so the page has to hand it over -- otherwise
   * that button stays a fixed blue no matter which theme is on.
   */
  accentColor: string;
  recentProjects: { path: string; displayName: string }[];
  projectName: string;
  // Bumped on every performAction() call regardless of trigger (hotkey,
  // MIDI, native menu, web POST) -- lets the shell briefly flash the
  // matching menu item, mirroring the old AppKit MacMenuBar behavior.
  lastAction: string;
  lastActionNonce: number;
  /** Live transport state. Drives the shell's idle policy (electron/src/
   *  main.mts): a hidden window is only ever allowed to sleep while stopped. */
  playing: boolean;
}

type BridgeWindow = typeof window & {
  resostageElectron?: {
    isElectron?: boolean;
    sendMenuState: (state: ElectronMenuState) => void;
    sendAction: (action: string) => void;
    setTypingFocus?: (focused: boolean) => void;
    setKeyCaptureActive?: (active: boolean) => void;
  };
};

function bridge(): BridgeWindow["resostageElectron"] {
  return (window as BridgeWindow).resostageElectron;
}

let lastFingerprint = "";

function fingerprint(s: WebUiState): string {
  return JSON.stringify([
    s.canUndo,
    s.canRedo,
    s.undoLabel,
    s.redoLabel,
    s.uiTab,
    resolveCssVar("--accent", "#3b6cff"),
    (s.settings?.recentProjects ?? []).map((r) => [r.path, r.displayName]),
    s.projectName,
    s.lastAction,
    s.lastActionNonce,
    s.playing,
  ]);
}

export function forwardMenuState(s: WebUiState): void {
  if (!IS_ELECTRON) return;
  const b = bridge();
  if (!b || !b.sendMenuState) return;
  const key = fingerprint(s);
  if (key === lastFingerprint) return;
  lastFingerprint = key;
  b.sendMenuState({
    canUndo: s.canUndo ?? false,
    canRedo: s.canRedo ?? false,
    undoLabel: s.undoLabel ?? "",
    redoLabel: s.redoLabel ?? "",
    uiTab: s.uiTab ?? "",
    accentColor: resolveCssVar("--accent", "#3b6cff"),
    recentProjects: s.settings?.recentProjects ?? [],
    projectName: s.projectName ?? "",
    lastAction: s.lastAction ?? "",
    lastActionNonce: s.lastActionNonce ?? 0,
    playing: s.playing ?? false,
  });
}

/**
 * Tell the shell whether a text field has focus.
 *
 * The shell captures configured keys and forwards their action IDs to the
 * renderer's HotkeyManager (see installHotkeyHandler in electron/src/main.mts).
 * It cannot see focus inside the document, so without this a bare-key action
 * could consume input while somebody is naming a track.
 */
export function sendTypingFocus(focused: boolean): void {
  if (!IS_ELECTRON) return;
  bridge()?.setTypingFocus?.(focused);
}

/** Keep native shortcut capture out of Settings' key-binding learn gesture. */
export function sendKeyCaptureActive(active: boolean): void {
  if (!IS_ELECTRON) return;
  bridge()?.setKeyCaptureActive?.(active);
}
