// macOS implementation of PlatformAdapter.
//
// Owns the two mac-only native dylibs (MenuFlash.m / Haptics.m, loaded via
// koffi), the app-bundle nested Core discovery, the global application menu,
// and the Touch Bar. Everything mac-specific about the shell lives here.

import { app, Menu, TouchBar } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  PlatformAdapter,
  type PlatformContext,
  type PlatformMenuSections,
} from "./PlatformAdapter.js";
import { createSystemTray, type SystemTray } from "./tray.js";

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
      execFileSync("pkill", ["-9", "-f", "ResoStage Core"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }

  override preloadNatives(): void {
    this.ensureNativeMenuFlash();
    this.ensureNativeHaptics();
  }

  private loadNativeLib<T>(libName: string): ((
    funcName: string,
    ret: string,
    args: string[],
  ) => (...args: unknown[]) => void) | null {
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

  private ensureNativeMenuFlash(): ((topTitle: string, itemTitle: string) => void) | null {
    if (this.flashMenuItemNative) return this.flashMenuItemNative;
    if (this.flashLoadAttempted) return null;
    this.flashLoadAttempted = true;
    const load = this.loadNativeLib("MenuFlash.dylib");
    if (!load) return null;
    try {
      this.flashMenuItemNative = load("FlashMenuItem", "void", ["str", "str"]) as (
        topTitle: string,
        itemTitle: string,
      ) => void;
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
    // This adapter compiles to Contents/Resources/app/dist/platform; the
    // nested Core sits alongside at Contents/Resources/ResoStage Core.app, so
    // go up 3 levels (platform -> dist -> app -> Resources).
    const resourcesDir = path.resolve(import.meta.dirname, "..", "..", "..");
    const corePath = path.join(
      resourcesDir,
      "ResoStage Core.app",
      "Contents",
      "MacOS",
      "ResoStage Core",
    );
    return existsSync(corePath) ? corePath : null;
  }

  override applyMenu(menu: Menu): void {
    Menu.setApplicationMenu(menu);
  }

  override supportsTouchBar(): boolean {
    return Boolean(TouchBar && TouchBar.TouchBarButton);
  }

  override buildTouchBar(
    tabs: Array<{ id: string; label: string }>,
    uiTab: string,
    accentColor: string,
  ) {
    if (!this.supportsTouchBar()) return undefined;
    const TouchBarButton = TouchBar.TouchBarButton;
    if (!tabs.length) return undefined;
    const buttons = tabs.map(
      (t) =>
        new TouchBarButton({
          label: t.label,
          // Full accent rather than the soft tone the page uses: TouchBarButton
          // only exposes backgroundColor, so the label stays the system white,
          // and white on a 15% wash is not the same button at all.
          backgroundColor:
            t.id === uiTab ? accentColor || "#3b6cff" : undefined,
          click: () => void this.context.postAction(`mode_${t.id}`),
        }),
    );
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
