// ResoStage platform abstraction.
//
// Every bit of code that differs between macOS / Windows / Linux lives behind
// this interface. main.mts only ever talks to the adapter returned by
// `createPlatformAdapter()`, never to `process.platform` directly — so a new
// platform (or a different shell, e.g. WKWebView) is a new adapter, not a
// scatter of `if (platform === …)` branches through the main process.
//
// Each adapter is allowed (expected) to no-op for the capabilities that
// platform does not support: e.g. the Windows adapter returns false from
// `supportsTouchBar()` and the Linux one has no tray.

import type { BrowserWindow, Menu, TouchBar } from "electron";
import type { MenuItemConstructorOptions } from "electron";

/** Cross-platform shape of an input event (subset of Electron's). */
export interface PlatformInput {
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
  key: string | undefined;
}

/** Backend/state that the adapter may need from the shell. */
export interface PlatformContext {
  getMainWindow: () => BrowserWindow | null;
  postAction: (action: string) => Promise<boolean>;
  /** User-facing process name (menu "ResoStage" vs app-menu label). */
  appName: string;
}

/**
 * A menu section as produced by buildMenu's platform-independent part, before
 * per-platform adaptation. Mirrors what buildMenu hands to the adapter.
 */
export type PlatformMenuSections = Array<{
  label: string;
  submenu: MenuItemConstructorOptions[] | MenuItemConstructorOptions;
}>;

export abstract class PlatformAdapter {
  readonly context: PlatformContext;

  constructor(context: PlatformContext) {
    this.context = context;
  }

  /** Human-readable platform key ("mac", "win32", "linux"). */
  abstract readonly key: "mac" | "win32" | "linux";

  /** Whether a "cmd" binding means the Command (meta) key on this platform. */
  abstract readonly commandIsMeta: boolean;

  // ── IPC / backend ───────────────────────────────────────────────────────

  /** Path to the Core's IPC socket (named pipe on Windows, Unix socket elsewhere). */
  abstract ipcSocketPath(): string;

  /** Locate the nested Core binary inside the bundle/dev tree, or null. */
  abstract findNestedCoreBinary(): string | null;

  /** Called right before spawning the backend (e.g. Windows taskkill strays). */
  cleanupBeforeBackendSpawn(): void {}

  /** Called after killing the backend (e.g. Windows taskkill leftovers). */
  cleanupAfterBackendKill(): void {}

  // ── Native helpers (mac-only dylibs etc.) ───────────────────────────────

  /** Eager-load platform native libraries (MenuFlash/Haptics). Best-effort. */
  preloadNatives(): void {}

  /** Flash a menu item in the OS menu bar (macOS only). No-op elsewhere. */
  flashMenuItem(_sectionTitle: string, _itemTitle: string): void {
    console.warn("MenuFlash: not supported on this platform");
  }

  /** Trackpad haptic tick (macOS only). No-op elsewhere. */
  hapticFeedback(_pattern: number): void {}

  // ── Window / shell affordances ──────────────────────────────────────────

  /** Whether this platform supports a Touch Bar. */
  supportsTouchBar(): boolean {
    return false;
  }

  /** Build the Touch Bar for the given tabs, or undefined if unsupported. */
  buildTouchBar(
    _tabs: Array<{ id: string; label: string }>,
    _uiTab: string,
    _accentColor: string,
  ): TouchBar | undefined {
    return undefined;
  }

  /** Apply a fully-built menu to the platform's menu surface. */
  abstract applyMenu(menu: Menu): void;

  /**
   * Adapt menu sections to the platform's menu conventions (e.g. fold the
   * "ResoStage" app menu into File on Windows/Linux). Called after the
   * platform-independent section assembly and before Menu.buildFromTemplate.
   */
  adaptMenuSections(_sections: PlatformMenuSections): void {}

  /** Register OS file associations (Windows registry). Best-effort. */
  registerFileAssociations(): void {}

  /**
   * Wire up OS "open this project file" entry points (macOS open-file event).
   * On platforms that deliver the path via argv instead, handle it in
   * handleProjectFileArgv().
   */
  registerOpenFileHandler(_handle: (path: string) => void): void {}

  /** Extract a project file path from argv, if this platform delivers it that way. */
  handleProjectFileArgv(_argv: string[]): string | null {
    return null;
  }

  // ── Tray (Windows only) ─────────────────────────────────────────────────

  /** Install the system-tray icon + menu. No-op where unsupported. */
  installTray(): void {}

  /** Tear down the tray on quit. No-op where unsupported. */
  destroyTray(): void {}
}
