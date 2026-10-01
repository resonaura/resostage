/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// macOS implementation of PlatformAdapter.
//
// Owns the two mac-only native dylibs (MenuFlash.m / Haptics.m, loaded via
// koffi), the app-bundle nested Core discovery, the global application menu,
// and the Touch Bar. Everything mac-specific about the shell lives here.

import { app, Menu, TouchBar, type BrowserWindow } from "electron";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  PlatformAdapter,
  type PlatformContext,
  type PlatformMenuSections,
} from "@/platform/PlatformAdapter.js";
import { createSystemTray, type SystemTray } from "@/platform/tray.js";

type KoffiModule = {
  load: (p: string) => {
    func: (
      name: string,
      ret: string,
      args: string[],
    ) => (...args: unknown[]) => void;
  };
};

export class MacPlatformAdapter extends PlatformAdapter {
  readonly key = "mac" as const;
  readonly commandIsMeta = true;

  private flashMenuItemNative:
    | ((topTitle: string, itemTitle: string) => void)
    | null = null;
  private flashLoadAttempted = false;

  private hapticFeedbackNative: ((pattern: number) => void) | null = null;
  private hapticLoadAttempted = false;

  private tray: SystemTray | null = null;

  constructor(context: PlatformContext) {
    super(context);
    this.tray = createSystemTray(context);
  }

  override cleanupBeforeBackendSpawn(): void {
    try {
      execFileSync("pkill", ["-9", "-x", "ResoStage Core"], {
        stdio: "ignore",
      });
    } catch {
      /* ignore */
    }
  }

  override forceKillSelfTree(backendPid?: number): void {
    const candidates = [
      path.join(
        process.resourcesPath,
        "ResoStage Core.app",
        "Contents",
        "Resources",
        "ResoStage Kaishaku.app",
        "Contents",
        "MacOS",
        "ResoStage Kaishaku",
      ),
      path.join(
        process.resourcesPath,
        "ResoStage Core.app",
        "Contents",
        "Resources",
        "kaishaku",
      ),
      path.join(
        process.resourcesPath,
        "ResoStage Kaishaku.app",
        "Contents",
        "MacOS",
        "ResoStage Kaishaku",
      ),
      path.join(
        process.resourcesPath,
        "ResoStage Kaishaku.app",
        "Contents",
        "MacOS",
        "kaishaku",
      ),
      path.join(
        process.resourcesPath,
        "kaishaku.app",
        "Contents",
        "MacOS",
        "kaishaku",
      ),
      path.join(process.resourcesPath, "kaishaku"),
      path.join(process.resourcesPath, "..", "kaishaku"),
      path.join(path.dirname(process.execPath), "kaishaku"),
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "core",
        "build",
        "app",
        "kaishaku_artefacts",
        "RelWithDebInfo",
        "ResoStage Kaishaku.app",
        "Contents",
        "MacOS",
        "ResoStage Kaishaku",
      ),
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "core",
        "build",
        "app",
        "kaishaku.app",
        "Contents",
        "MacOS",
        "kaishaku",
      ),
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "core",
        "build",
        "app",
        "kaishaku",
      ),
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "core",
        "build",
        "app",
        "RelWithDebInfo",
        "kaishaku.app",
        "Contents",
        "MacOS",
        "kaishaku",
      ),
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "core",
        "build",
        "app",
        "RelWithDebInfo",
        "kaishaku",
      ),
    ];

    const pidsToKill: string[] = [String(process.pid)];
    if (backendPid && backendPid > 0) {
      pidsToKill.push(String(backendPid));
    }

    for (const cand of candidates) {
      if (existsSync(cand)) {
        try {
          spawn(cand, pidsToKill, { detached: true, stdio: "ignore" }).unref();
          process.exit(0);
          return;
        } catch {
          /* fallback below */
        }
      }
    }
    try {
      execFileSync("pkill", ["-9", "-x", "ResoStage"], { stdio: "ignore" });
    } catch {}
    process.exit(0);
  }

  override preloadNatives(): void {
    this.ensureNativeMenuFlash();
    this.ensureNativeHaptics();
  }

  private loadNativeLib<T>(
    libName: string,
  ):
    | ((
        funcName: string,
        ret: string,
        args: string[],
      ) => (...args: unknown[]) => void)
    | null {
    // This adapter compiles to Contents/Resources/app/dist/platform, but the
    // native dylibs are built to dist/ (one level up).
    const libPath = path.join(import.meta.dirname, "..", libName);
    if (!existsSync(libPath)) {
      console.warn(`${libName} missing at`, libPath);
      return null;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const koffi = createRequire(import.meta.url)("koffi") as KoffiModule;
      const lib = koffi.load(libPath);
      return lib.func.bind(lib);
    } catch (err) {
      console.warn(`${libName} unavailable:`, err);
      return null;
    }
  }

  private ensureNativeMenuFlash():
    | ((topTitle: string, itemTitle: string) => void)
    | null {
    if (this.flashMenuItemNative) return this.flashMenuItemNative;
    if (this.flashLoadAttempted) return null;
    this.flashLoadAttempted = true;
    const load = this.loadNativeLib("MenuFlash.dylib");
    if (!load) return null;
    try {
      this.flashMenuItemNative = load("FlashMenuItem", "void", [
        "str",
        "str",
      ]) as (topTitle: string, itemTitle: string) => void;
      console.log("MenuFlash: loaded");
      return this.flashMenuItemNative;
    } catch (err) {
      console.warn("MenuFlash unavailable:", err);
      return null;
    }
  }

  private ensureNativeHaptics(): ((pattern: number) => void) | null {
    if (this.hapticFeedbackNative) return this.hapticFeedbackNative;
    if (this.hapticLoadAttempted) return null;
    this.hapticLoadAttempted = true;
    const load = this.loadNativeLib("Haptics.dylib");
    if (!load) return null;
    try {
      this.hapticFeedbackNative = load("PerformHapticFeedback", "void", [
        "int",
      ]) as (pattern: number) => void;
      console.log("Haptics: loaded");
      return this.hapticFeedbackNative;
    } catch (err) {
      console.warn("Haptics unavailable:", err);
      return null;
    }
  }

  override flashMenuItem(sectionTitle: string, itemTitle: string): void {
    const fn = this.ensureNativeMenuFlash();
    if (!fn) {
      console.warn("MenuFlash: native dylib not loaded");
      return;
    }
    fn(sectionTitle, itemTitle);
  }

  override hapticFeedback(pattern: number): void {
    const fn = this.ensureNativeHaptics();
    if (!fn) return;
    fn(pattern);
  }

  override ipcSocketPath(): string {
    return path.join(app.getPath("temp"), "resostage-core.sock");
  }

  override findNestedCoreBinary(): string | null {
    const resourcesDir = path.resolve(import.meta.dirname, "..", "..", "..");
    const candidates = [
      path.join(
        resourcesDir,
        "ResoStage Core.app",
        "Contents",
        "MacOS",
        "ResoStage",
      ),
      path.join(
        resourcesDir,
        "ResoStage Core.app",
        "Contents",
        "MacOS",
        "ResoStage Core",
      ),
      path.join(
        resourcesDir,
        "ResoStage.app",
        "Contents",
        "MacOS",
        "ResoStage",
      ),
      path.join(
        resourcesDir,
        "ResoStage.app",
        "Contents",
        "MacOS",
        "ResoStage Core",
      ),
      path.join(
        process.cwd(),
        "build",
        "mac",
        "arm64",
        "ResoStage.app",
        "Contents",
        "Resources",
        "ResoStage Core.app",
        "Contents",
        "MacOS",
        "ResoStage",
      ),
      path.join(
        process.cwd(),
        "build",
        "mac",
        "x64",
        "ResoStage.app",
        "Contents",
        "Resources",
        "ResoStage Core.app",
        "Contents",
        "MacOS",
        "ResoStage",
      ),
      path.join(
        process.cwd(),
        "core",
        "build",
        "app",
        "ResoStage_artefacts",
        "RelWithDebInfo",
        "ResoStage.app",
        "Contents",
        "MacOS",
        "ResoStage",
      ),
      path.join(
        process.cwd(),
        "core",
        "build",
        "app",
        "ResoStage_artefacts",
        "Debug",
        "ResoStage.app",
        "Contents",
        "MacOS",
        "ResoStage",
      ),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  override applyMenu(menu: Menu): void {
    Menu.setApplicationMenu(menu);
  }

  private touchBarButtons = new Map<string, InstanceType<typeof TouchBar.TouchBarButton>>();
  private currentTouchBarAccent = "";

  override supportsTouchBar(): boolean {
    return Boolean(TouchBar && TouchBar.TouchBarButton);
  }

  override updateTouchBarTab(uiTab: string, accentColor: string): boolean {
    if (!this.touchBarButtons.size) return false;
    this.currentTouchBarAccent = accentColor;
    const activeColor = accentColor || "#3b6cff";
    for (const [id, btn] of this.touchBarButtons.entries()) {
      btn.backgroundColor = id === uiTab ? activeColor : "";
    }
    return true;
  }

  override buildTouchBar(
    tabs: Array<{ id: string; label: string }>,
    uiTab: string,
    accentColor: string,
  ) {
    if (!this.supportsTouchBar()) return undefined;
    const TouchBarButton = TouchBar.TouchBarButton;
    if (!tabs.length) return undefined;

    this.touchBarButtons.clear();
    this.currentTouchBarAccent = accentColor;
    const activeColor = accentColor || "#3b6cff";

    const buttons = tabs.map((t) => {
      const btn = new TouchBarButton({
        label: t.label,
        backgroundColor: t.id === uiTab ? activeColor : undefined,
        click: () => {
          // Immediately update Touch Bar in-place for 0ms tactile feedback
          this.updateTouchBarTab(t.id, this.currentTouchBarAccent);
          // Dispatch immediately to renderer so screen switches with zero latency
          const win = this.context.getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send("dispatch-hotkey", { action: `mode_${t.id}` });
          }
          // Notify backend
          void this.context.postAction(`mode_${t.id}`);
        },
      });
      this.touchBarButtons.set(t.id, btn);
      return btn;
    });

    return new TouchBar({ items: buttons });
  }

  override adaptMenuSections(sections: PlatformMenuSections): void {
    // macOS keeps the "ResoStage" app menu as-is; the platform-independent
    // assembly already yields the conventional mac layout. Nothing to change.
    void sections;
  }

  override registerOpenFileHandler(handle: (path: string) => void): void {
    // macOS delivers double-clicked project files via the open-file event,
    // which fires when the app is already running.
    app.on("open-file", (event, filePath) => {
      event.preventDefault();
      handle(filePath);
    });
  }

  // ── Window sizing / positioning ─────────────────────────────────────────

  override getInitialWindowBounds(workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    // On macOS, use the display's exact workArea (visibleFrame):
    // starts right beneath the menu bar and stops right above the Dock.
    return workArea;
  }

  override applyInitialWindowState(_win: BrowserWindow): void {
    // Window is created with the exact workArea bounds, cleanly filling
    // the screen between menu bar and Dock without entering exclusive fullscreen Space.
  }

  // ── Tray (macOS menu bar status item) ───────────────────────────────────
  // Uses the shared tray implementation (tray.ts). The icon must be a template
  // image so macOS auto-colours it for light/dark menu bars.

  override installTray(): void {
    this.tray?.install();
  }

  destroyTray(): void {
    this.tray?.destroy();
  }
}
