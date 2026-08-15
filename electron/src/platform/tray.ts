// Shared system-tray implementation for the Windows and Linux adapters.
// Both platforms use Electron's Tray in the same way (icon + context menu
// with Show/Exit, theme-aware icon), so the logic lives here once instead of
// being duplicated across adapters.

import { app, Menu, nativeTheme, Tray } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PlatformContext } from "./PlatformAdapter.js";

export interface SystemTray {
  install(): void;
  destroy(): void;
}

/**
 * Candidate locations for the tray icon. The build copies the repo `icons/`
 * folder into the packaged app at `resources/app/icons/`, but we also accept
 * a few development/relative fallbacks so `electron .` from the repo works.
 */
function trayIconCandidates(name: string): string[] {
  const white = `tray-${name}.png`;
  const svg = `tray-${name}.svg`;
  const base = [
    path.join(import.meta.dirname, "..", "icons", white),
    path.join(app.getAppPath(), "icons", white),
    path.join(import.meta.dirname, "..", "..", "icons", white),
    path.join(import.meta.dirname, "..", "icons", svg),
    path.join(app.getAppPath(), "icons", svg),
    path.join(import.meta.dirname, "..", "icons", "tray.png"),
    path.join(app.getAppPath(), "icons", "tray.png"),
    path.join(import.meta.dirname, "..", "icons", "app.png"),
    path.join(app.getAppPath(), "icons", "app.png"),
    path.join(import.meta.dirname, "..", "icons", "app.ico"),
    path.join(app.getAppPath(), "icons", "app.ico"),
  ];
  // Windows/Linux fall back to a bare exe/shell icon if nothing tray-specific
  // exists. Keep the list deduped.
  return [...new Set(base)];
}

function resolveTrayIcon(): string | null {
  const darkTaskbar = nativeTheme.shouldUseDarkColors;
  const name = darkTaskbar ? "white" : "dark";
  for (const p of trayIconCandidates(name)) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function createSystemTray(context: PlatformContext): SystemTray {
  let tray: Tray | null = null;

  function showMainWindow(): void {
    const win = context.getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  }

  function updateIconTheme(): void {
    if (!tray) return;
    const icon = resolveTrayIcon();
    if (!icon) return;
    try {
      tray.setImage(icon);
    } catch (err) {
      console.warn("[resostage] Failed to set tray icon image:", err);
    }
  }

  function install(): void {
    if (tray) return;
    const icon = resolveTrayIcon();
    if (!icon) return;

    try {
      tray = new Tray(icon);
      tray.setToolTip("ResoStage");
      const contextMenu = Menu.buildFromTemplate([
        {
          label: "Show ResoStage",
          click: showMainWindow,
        },
        { type: "separator" },
        { label: "Exit", click: () => void context.postAction("quit") },
      ]);
      tray.setContextMenu(contextMenu);

      const popup = () => {
        if (tray && !tray.isDestroyed()) tray.popUpContextMenu(contextMenu);
      };
      tray.on("right-click", popup);
      tray.on("click", popup);
      tray.on("double-click", showMainWindow);

      updateIconTheme();
      nativeTheme.on("updated", updateIconTheme);
    } catch (err) {
      console.warn("[resostage] Failed to setup system tray:", err);
    }
  }

  function destroy(): void {
    if (tray) {
      try {
        tray.destroy();
      } catch {
        /* ignore */
      }
      tray = null;
    }
  }

  return { install, destroy };
}
