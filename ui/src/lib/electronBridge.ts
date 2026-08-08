import { IS_ELECTRON } from "./electron";
import type { WebUiState } from "./types";

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
    recentProjects: s.settings?.recentProjects ?? [],
    projectName: s.projectName ?? "",
    lastAction: s.lastAction ?? "",
    lastActionNonce: s.lastActionNonce ?? 0,
    playing: s.playing ?? false,
  });
}
