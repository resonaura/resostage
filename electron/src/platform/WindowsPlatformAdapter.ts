// Windows implementation of PlatformAdapter.
//
// Owns the named-pipe IPC socket, the registry file associations for the
// portable build, and the "fold the app menu into File" adaptation. The menu
// lives in the window title bar (mainWindow.setMenu), not the global
// application menu. The tray is shared with Linux (see tray.ts).

import { Menu } from "electron";
import { spawn, execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  PlatformAdapter,
  type PlatformContext,
  type PlatformMenuSections,
} from "./PlatformAdapter.js";
import { createSystemTray, type SystemTray } from "./tray.js";

const CORE_EXE = "core.exe";
const OLD_CORE_EXE = "ResoStage Core.exe";

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
    } catch {}
    try {
      execFileSync("taskkill", ["/IM", OLD_CORE_EXE, "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
  }

  override cleanupAfterBackendKill(): void {
    try {
      execFileSync("taskkill", ["/IM", CORE_EXE, "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
    try {
      execFileSync("taskkill", ["/IM", OLD_CORE_EXE, "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
  }

  override forceKillSelfTree(backendPid?: number): void {
    const exe = process.execPath;
    const candidates = [
      path.join(path.dirname(exe), "kaishaku.exe"),
      path.join(process.resourcesPath, "..", "kaishaku.exe"),
      path.join(process.resourcesPath, "kaishaku.exe"),
      path.join(import.meta.dirname, "..", "..", "..", "build", "win", process.arch, "kaishaku.exe"),
      path.join(process.cwd(), "build", "win", process.arch, "kaishaku.exe"),
      path.join(import.meta.dirname, "..", "..", "..", "build", "win", "arm64", "kaishaku.exe"),
      path.join(import.meta.dirname, "..", "..", "..", "build", "win", "x64", "kaishaku.exe"),
      path.join(process.cwd(), "build", "win", "arm64", "kaishaku.exe"),
      path.join(process.cwd(), "build", "win", "x64", "kaishaku.exe"),
    ];
    let kaishakuPath: string | null = null;
    for (const cand of candidates) {
      if (existsSync(cand)) {
        kaishakuPath = cand;
        break;
      }
    }

    const pidsToKill: string[] = [String(process.pid)];
    if (backendPid && backendPid > 0) {
      pidsToKill.push(String(backendPid));
    }

    if (kaishakuPath) {
      try {
        spawn(kaishakuPath, pidsToKill, {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        }).unref();
        process.exit(0);
        return;
      } catch {
        /* fallback */
      }
    }

    try {
      execFileSync("taskkill", ["/PID", String(process.pid), "/F", "/T"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
    process.exit(0);
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
    // 1. Delete old/stale folder associations or old extension entries under HKCU\Software\Classes
    const base = "HKCU\\Software\\Classes";
    const staleKeys = [
      `${base}\\.rsnraset`, // remove folder association from registry so Windows treats .rsnraset as a normal folder
      `${base}\\.rsnrasetmeta`,
      `${base}\\ResoStage.ProjectFile`,
      `${base}\\resostage.ProjectFile`,
    ];
    for (const key of staleKeys) {
      try {
        execFileSync("reg", ["delete", key, "/f"], { windowsHide: true, stdio: "ignore" });
      } catch {
        /* ignore if key didn't exist */
      }
    }

    // 2. Resolve file.ico path for .rsnrasetmeta icon association
    const exe = process.execPath;
    const candidates = [
      path.join(process.resourcesPath, "file.ico"),
      path.join(process.resourcesPath, "icons", "file.ico"),
      path.join(path.dirname(exe), "file.ico"),
      path.join(path.dirname(exe), "resources", "file.ico"),
      path.join(import.meta.dirname, "..", "..", "..", "icons", "file.ico"),
      path.join(process.cwd(), "icons", "file.ico"),
    ];
    let iconPath = `${exe},0`;
    for (const cand of candidates) {
      if (existsSync(cand)) {
        iconPath = `"${cand}",0`;
        break;
      }
    }

    // 3. Register fresh extension and ProgID entries
    const entries: Array<[key: string, value: string]> = [
      [`${base}\\.rsnrasetmeta`, "resostage.ProjectFile"],
      [`${base}\\resostage.ProjectFile`, "ResoStage Project File"],
      [`${base}\\resostage.ProjectFile\\DefaultIcon`, iconPath],
      [`${base}\\resostage.ProjectFile\\shell\\open\\command`, `"${exe}" "%1"`],
    ];

    for (const [key, value] of entries) {
      try {
        execFileSync("reg", ["add", key, "/ve", "/d", value, "/f"], { windowsHide: true, stdio: "ignore" });
      } catch {
        /* best-effort */
      }
    }

    // 4. Notify Windows Shell of file association changes so Explorer immediately updates icons
    try {
      const psCmd = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Shell { [DllImport("shell32.dll")] public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2); }'; [Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)`;
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", psCmd], { windowsHide: true }, () => {
        /* best-effort */
      });
    } catch {
      /* ignore */
    }
  }

  override handleProjectFileArgv(argv: string[]): string | null {
    // Windows/Linux deliver the double-clicked path via argv.
    const fileArg = argv.find((a) => {
      const clean = a.replace(/^"+|"+$/g, "");
      return (
        clean.endsWith(".rsnrasetmeta") ||
        clean.endsWith(".rsnraset") ||
        clean.endsWith("project.rsnrasetmeta")
      );
    });
    return fileArg ? fileArg.replace(/^"+|"+$/g, "") : null;
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

export { WindowsPlatformAdapter as WinPlatformAdapter };
