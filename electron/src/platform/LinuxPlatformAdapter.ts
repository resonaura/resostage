// Linux implementation of PlatformAdapter.
//
// Closest to "least special": Unix-domain IPC socket, app bundle discovery is
// the same temp-dir socket, the global application menu (Electron auto-detects
// D-Bus com.canonical.AppMenu.Registrar and renders in-window when absent),
// and project files arrive via argv. No Touch Bar, no native dylibs. The tray
// is shared with Windows (see tray.ts).

import { app, Menu } from "electron";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  PlatformAdapter,
  type PlatformContext,
  type PlatformMenuSections,
} from "./PlatformAdapter.js";
import { createSystemTray, type SystemTray } from "./tray.js";

const CORE_NAME = "core";
const OLD_CORE_NAME = "ResoStage";

export class LinuxPlatformAdapter extends PlatformAdapter {
  readonly key = "linux" as const;
  readonly commandIsMeta = false;

  private tray: SystemTray | null = null;

  constructor(context: PlatformContext) {
    super(context);
    this.tray = createSystemTray(context);
  }

  override cleanupBeforeBackendSpawn(): void {
    try {
      execFileSync("pkill", ["-9", "-x", CORE_NAME], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("pkill", ["-9", "-x", OLD_CORE_NAME], { stdio: "ignore" });
    } catch {}
  }

  override forceKillSelfTree(backendPid?: number): void {
    const candidates = [
      path.join(path.dirname(process.execPath), "kaishaku"),
      path.join(process.resourcesPath, "kaishaku"),
      path.join(import.meta.dirname, "..", "..", "..", "build", "linux", process.arch, "kaishaku"),
      path.join(import.meta.dirname, "..", "..", "..", "core", "build", "app", "kaishaku"),
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
      execFileSync("pkill", ["-9", "-x", "resostage"], { stdio: "ignore" });
    } catch {}
    process.exit(0);
  }

  override ipcSocketPath(): string {
    return path.join(app.getPath("temp"), "resostage-core.sock");
  }

  override findNestedCoreBinary(): string | null {
    // Linux bundle: a bare executable alongside the shell bundle in dist/.
    const candidates = [
      path.join(import.meta.dirname, "..", "..", "..", "build", "linux", process.arch, CORE_NAME),
      path.join(process.cwd(), "build", "linux", process.arch, CORE_NAME),
      path.join(import.meta.dirname, "..", "..", "..", "build", "linux", CORE_NAME),
      path.join(process.cwd(), "build", "linux", CORE_NAME),
    ];
    for (const cand of candidates) {
      if (existsSync(cand)) return cand;
    }
    return null;
  }

  override applyMenu(menu: Menu): void {
    // Let Electron handle D-Bus detection internally: setApplicationMenu
    // exports to D-Bus when a registrar is present (KDE/Unity) or renders
    // in-window otherwise (GNOME/minimal WMs).
    Menu.setApplicationMenu(menu);
  }

  override adaptMenuSections(sections: PlatformMenuSections): void {
    // Identical folding to Windows: no global "ResoStage" app menu.
    if (!sections.length) return;
    const firstSection = sections[0];
    if (firstSection?.label === "ResoStage") {
      const appItems = Array.isArray(firstSection.submenu)
        ? firstSection.submenu
        : [];
      const fileIdx = sections.findIndex((s) => s.label === "File");
      if (fileIdx >= 0) {
        const fileSubmenu = Array.isArray(sections[fileIdx].submenu)
          ? sections[fileIdx].submenu
          : [];
        const quitItem = appItems.find(
          (item) =>
            item.label?.includes("Quit") || (item as { actionId?: string }).actionId === "quit",
        );
        if (quitItem) {
          fileSubmenu.push({ type: "separator" });
          fileSubmenu.push(quitItem);
        }
        sections[fileIdx].submenu = fileSubmenu;
      }
      sections.shift();
    }

    const winIdx = sections.findIndex((s) => s.label === "Window");
    if (winIdx >= 0) {
      const winSubmenu = Array.isArray(sections[winIdx].submenu)
        ? sections[winIdx].submenu
        : [];
      sections[winIdx].submenu = winSubmenu.filter(
        (item) => (item as { role?: string }).role !== "zoom",
      );
    }
  }

  override handleProjectFileArgv(argv: string[]): string | null {
    const fileArg = argv.find(
      (a) => a.endsWith(".rsnrasetmeta") || a.endsWith(".rsnraset"),
    );
    return fileArg ?? null;
  }

  // ── Tray ────────────────────────────────────────────────────────────────
  // Shared with Windows (see tray.ts); delegate to the common implementation.

  override installTray(): void {
    this.tray?.install();
  }

  destroyTray(): void {
    this.tray?.destroy();
  }
}
