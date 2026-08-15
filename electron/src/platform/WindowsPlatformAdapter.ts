// Windows implementation of PlatformAdapter.
//
// Owns the named-pipe IPC socket, the registry file associations for the
// portable build, and the "fold the app menu into File" adaptation. The menu
// lives in the window title bar (mainWindow.setMenu), not the global
// application menu. The tray is shared with Linux (see tray.ts).

import { Menu } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  PlatformAdapter,
  type PlatformContext,
  type PlatformMenuSections,
} from "./PlatformAdapter.js";
import { createSystemTray, type SystemTray } from "./tray.js";

const CORE_EXE = "ResoStage Core.exe";

export class WindowsPlatformAdapter extends PlatformAdapter {
  readonly key = "win32" as const;
  readonly commandIsMeta = false;

  private tray: SystemTray | null = null;

  constructor(context: PlatformContext) {
    super(context);
    this.tray = createSystemTray(context);
  }

  override cleanupBeforeBackendSpawn(): void {
    // A Core that outlived a killed/crashed shell (or an old build) still
    // binds :2899 and serves the SPA's .js as text/html -> black window. With
    // the single-instance lock held we know no other legit instance runs.
    try {
      execFileSync("taskkill", ["/IM", CORE_EXE, "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      /* no old process running -- ignore */
    }
  }

  override cleanupAfterBackendKill(): void {
    try {
      execFileSync("taskkill", ["/IM", CORE_EXE, "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      /* ignore */
    }
  }

  override ipcSocketPath(): string {
    // Windows uses a named pipe (the Core prepends \\.\pipe\ itself), so we
    // pass a bare pipe name.
    return "resostage-core.sock";
  }

  override findNestedCoreBinary(): string | null {
    const winCorePath = path.join(process.resourcesPath, "..", CORE_EXE);
    if (existsSync(winCorePath)) return winCorePath;

    const devCandidates = [
      path.join(import.meta.dirname, "..", "..", "..", "build", "win", "x64", CORE_EXE),
      path.join(process.cwd(), "build", "win", "x64", CORE_EXE),
      path.join(
        process.cwd(),
        "core",
        "build",
        "app",
        "ResoStage_artefacts",
        "RelWithDebInfo",
        CORE_EXE,
      ),
      path.join(
        process.cwd(),
        "core",
        "build",
        "app",
        "ResoStage_artefacts",
        "Debug",
        CORE_EXE,
      ),
    ];
    for (const cand of devCandidates) {
      if (existsSync(cand)) return cand;
    }
    return null;
  }

  override applyMenu(menu: Menu): void {
    // Windows: menu in the window title bar.
    Menu.setApplicationMenu(null);
    const win = this.context.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.setMenu(menu);
    }
  }

  override adaptMenuSections(sections: PlatformMenuSections): void {
    if (!sections.length) return;
    // On Windows/Linux the first section is typically "ResoStage" (app menu).
    // Rename/merge it to "File" and move "Quit" into File, per Windows/Linux
    // conventions.
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

  override registerFileAssociations(): void {
    // Register .rsnrasetmeta under HKCU so double-clicking opens the portable
    // build even without the Inno installer. Best-effort, non-fatal.
    const base = "HKCU\\Software\\Classes";
    const exe = process.execPath;
    const entries: Array<[key: string, value: string]> = [
      [`${base}\\.rsnrasetmeta`, "ResoStage.ProjectFile"],
      [`${base}\\ResoStage.ProjectFile`, "ResoStage Project File"],
      [`${base}\\ResoStage.ProjectFile\\DefaultIcon`, `${exe},0`],
      [`${base}\\ResoStage.ProjectFile\\shell\\open\\command`, `"${exe}" "%1"`],
    ];
    for (const [key, value] of entries) {
      execFile("reg", ["add", key, "/ve", "/d", value, "/f"], { windowsHide: true }, () => {
        /* best-effort */
      });
    }
  }

  override handleProjectFileArgv(argv: string[]): string | null {
    // Windows/Linux deliver the double-clicked path via argv.
    const fileArg = argv.find(
      (a) => a.endsWith(".rsnrasetmeta") || a.endsWith(".rsnraset"),
    );
    return fileArg ?? null;
  }

  // ── Tray ────────────────────────────────────────────────────────────────
  // The tray is shared with Linux (see tray.ts); these are thin delegations
  // kept so callers in main.mts don't need to branch per platform.

  override installTray(): void {
    this.tray?.install();
  }

  destroyTray(): void {
    this.tray?.destroy();
  }
}
