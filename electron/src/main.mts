// ResoStage Electron shell (Settings > UI = "electron").
//
// Architecture: the JUCE process stays alive headlessly as the backend
// (audio / lighting / transport / embedded WebServer on localhost:2899). The
// SPA runs in THIS window against that same server -- exactly like a remote
// browser tab or the in-window WKWebView -- while the native menu bar and
// Touch Bar that would otherwise belong to the JUCE window live here:
//
//   * menu structure  <- GET  /api/v1/ui/menu   (the SAME MenuModel table
//                        app/platform/MenuModel.* that MacMenuBar.mm builds
//                        the AppKit menu from -- single source, one JSON)
//   * live menu state <- ipcMain "menu-state"  (undo/redo, Open Recent,
//                        active Touch Bar tab, window title -- forwarded by
//                        the SPA off its 30 Hz state feed)
//   * menu clicks     -> POST /api/v1/action   (WebCommandKind::PerformAction
//                        -> MainComponent::performAction)
//
// Quit (menu item or window close) goes through the backend's unsaved-
// changes prompt; the backend then kills this process on shutdown.

import {
  app,
  BrowserWindow,
  Menu,
  TouchBar,
  ipcMain,
  powerMonitor,
  powerSaveBlocker,
  type MenuItemConstructorOptions,
} from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

// koffi loads dist/*.dylib (native/mac/*.m). Optional — missing dylib or
// non-mac simply skips the feature. Eager-loaded on app ready so load
// failures show up once at startup instead of silently on first use.
const require = createRequire(import.meta.url);

type KoffiModule = {
  load: (p: string) => {
    func: (
      name: string,
      ret: string,
      args: string[],
    ) => (...args: unknown[]) => void;
  };
};

let FlashMenuItemNative:
  | ((topTitle: string, itemTitle: string) => void)
  | null = null;
let FlashMenuLoadAttempted = false;
function EnsureNativeMenuFlash():
  | ((topTitle: string, itemTitle: string) => void)
  | null {
  if (FlashMenuItemNative) return FlashMenuItemNative;
  if (FlashMenuLoadAttempted) return null;
  FlashMenuLoadAttempted = true;
  if (process.platform !== "darwin") return null;
  const LibPath = path.join(import.meta.dirname, "MenuFlash.dylib");
  if (!existsSync(LibPath)) {
    console.warn("MenuFlash: dylib missing at", LibPath);
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Koffi = require("koffi") as KoffiModule;
    const Lib = Koffi.load(LibPath);
    // FlashMenuItem(topTitle, itemTitle) — itemTitle may be "".
    FlashMenuItemNative = Lib.func("FlashMenuItem", "void", ["str", "str"]) as (
      topTitle: string,
      itemTitle: string,
    ) => void;
    console.log("MenuFlash: loaded", LibPath);
    return FlashMenuItemNative;
  } catch (err) {
    console.warn("MenuFlash unavailable:", err);
    return null;
  }
}

let HapticFeedbackNative: ((pattern: number) => void) | null = null;
let HapticLoadAttempted = false;
function EnsureNativeHaptics(): ((pattern: number) => void) | null {
  if (HapticFeedbackNative) return HapticFeedbackNative;
  if (HapticLoadAttempted) return null;
  HapticLoadAttempted = true;
  if (process.platform !== "darwin") return null;
  const LibPath = path.join(import.meta.dirname, "Haptics.dylib");
  if (!existsSync(LibPath)) {
    console.warn("Haptics: dylib missing at", LibPath);
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Koffi = require("koffi") as KoffiModule;
    const Lib = Koffi.load(LibPath);
    HapticFeedbackNative = Lib.func("PerformHapticFeedback", "void", [
      "int",
    ]) as (pattern: number) => void;
    console.log("Haptics: loaded", LibPath);
    return HapticFeedbackNative;
  } catch (err) {
    console.warn("Haptics unavailable:", err);
    return null;
  }
}

function preloadNatives(): void {
  EnsureNativeMenuFlash();
  EnsureNativeHaptics();
}

const { TouchBarButton } = TouchBar;

// ── Live-by-default (no user toggle) ──────────────────────────────────────
// Stage app: the UI must keep running when minimized, alt-tabbed, or under
// another window. Chromium's default is to background-throttle the renderer
// (timers, rAF, sometimes the GPU surface) — that's the black screen after
// wake. These are permanent defaults, not optional flags.
//
// Must be set before app.ready.
function applyLiveRendererDefaults(): void {
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  // Win/Linux occlusion heuristic; harmless on macOS if ignored.
  app.commandLine.appendSwitch(
    "disable-features",
    "CalculateNativeWinOcclusion",
  );
}
applyLiveRendererDefaults();

// The on-screen product is "ResoStage" (JUCE stays headless as "ResoStage
// Core"). Electron would otherwise call itself "Electron" in the Dock/menu.
app.setName("ResoStage");

// Keep the process out of App Nap / forced suspension while the shell is up
// (display may still sleep; we recover UI on wake).
let appSuspensionBlockerId: number | null = null;
function ensureAppNotSuspended(): void {
  if (
    appSuspensionBlockerId === null ||
    !powerSaveBlocker.isStarted(appSuspensionBlockerId)
  ) {
    appSuspensionBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  }
}
function releaseAppSuspensionBlocker(): void {
  if (
    appSuspensionBlockerId !== null &&
    powerSaveBlocker.isStarted(appSuspensionBlockerId)
  ) {
    powerSaveBlocker.stop(appSuspensionBlockerId);
  }
  appSuspensionBlockerId = null;
}

const DEFAULT_PORT = 2899;

// Menu / state shapes mirrored from app/platform/MenuModel.h and
// ui/src/lib/electronBridge.ts (GET /api/v1/ui/menu).
interface MenuItemModel {
  separator?: boolean;
  kind?: "open-recent";
  title?: string;
  role?: string;
  actionId?: string;
  dynamicKey?: boolean;
  key?: string;
}

interface MenuSectionModel {
  title: string;
  items: MenuItemModel[];
}

interface MenuModel {
  menus: MenuSectionModel[];
  touchbar: { id: string; label: string }[];
  keybindings: Record<string, string>;
  recentProjects: RecentProjectEntry[];
}

interface RecentProjectEntry {
  path: string;
  displayName: string;
}

interface MenuState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  recentProjects: RecentProjectEntry[];
  uiTab: string;
  projectName: string;
  lastAction: string;
  lastActionNonce: number;
}

function backendPort(): number {
  const arg = process.argv.find((a) => a.startsWith("--backend-port="));
  const n = arg ? Number(arg.split("=")[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT;
}

const PORT = backendPort();
const BACKEND = `http://localhost:${PORT}`;
// Must match ui/vite.config.ts's DEV_PORT.
const DEV_PORT = 2900;
const DEV_URL = `http://localhost:${DEV_PORT}/?embedded=1`;
const EMBED_URL = `${BACKEND}/?embedded=1`;

// How hard to look for a Vite dev server before falling back to the UI build
// embedded in the app bundle.
//
//   "off"   never look -- what a show machine or a shipped build wants.
//   "probe" one fast check (default). Nothing listening on a local port is
//           refused immediately, so this costs well under a millisecond and
//           the app starts on the embedded build with no delay and no flash of
//           a failed load. `pnpm ui:dev` already running -> HMR, as before.
//   "wait"  poll for a few seconds, so `pnpm ui:dev` and the app can be
//           started in either order.
//
// Deliberately NOT keyed on app.isPackaged: the normal dev loop here is
// `pnpm rebuild:run`, which builds and launches the real .app bundle -- that
// IS packaged, and keying off it would silently kill HMR in the one workflow
// this is meant to serve.
const DEV_UI: "off" | "probe" | "wait" = (() => {
  const forced = process.env.RESOSTAGE_UI_DEV;
  if (forced === "0" || forced === "false" || forced === "off") return "off";
  if (forced === "wait") return "wait";
  return "probe";
})();

/** True once the Vite dev server answers; gives up after `budgetMs`. */
async function findDevServer(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const res = await fetch(DEV_URL, {
        method: "HEAD",
        signal: AbortSignal.timeout(500),
      });
      if (res.ok || res.status === 404) return true; // answering at all is enough
    } catch {
      /* refused or timed out */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Standalone launch (double-clicked ResoStage.app directly -- no
// --backend-port arg, which only the JUCE-spawned dev flow passes): we own
// spawning + supervising the nested JUCE backend at Contents/Resources/
// ResoStage Core.app instead of connecting to one JUCE already started.
const STANDALONE = !process.argv.some((a) => a.startsWith("--backend-port="));
let backendProcess: ChildProcess | null = null;

function findNestedCoreBinary(): string | null {
  // Packaged layout: this file runs from Contents/Resources/app/dist/
  // main.mjs, and the nested Core sits alongside at Contents/Resources/
  // ResoStage Core.app.
  const resourcesDir = path.resolve(import.meta.dirname, "..", "..");
  const corePath = path.join(
    resourcesDir,
    "ResoStage Core.app",
    "Contents",
    "MacOS",
    "ResoStage Core",
  );
  return existsSync(corePath) ? corePath : null;
}

function spawnBackend(): void {
  const corePath = findNestedCoreBinary();
  if (!corePath) {
    console.error(
      "Standalone launch but no nested ResoStage Core.app found -- cannot start backend",
    );
    return;
  }
  backendProcess = spawn(corePath, [], {
    env: { ...process.env, RESOSTAGE_SPAWNED_BY_SHELL: "1" },
    stdio: "ignore",
  });
  backendProcess.on("exit", () => {
    backendProcess = null;
    // The backend owns the unsaved-changes prompt on quit; once it's gone
    // there's nothing left for this shell to show.
    app.quit();
  });
}

function killBackend(): void {
  if (backendProcess && !backendProcess.killed) backendProcess.kill();
  backendProcess = null;
}

let mainWindow: BrowserWindow | null = null;
let menuModel: MenuModel | null = null; // cached GET /api/v1/ui/menu
let menuState: MenuState = {
  canUndo: false,
  canRedo: false,
  undoLabel: "",
  redoLabel: "",
  recentProjects: [],
  uiTab: "",
  projectName: "",
  lastAction: "",
  lastActionNonce: 0,
};
let lastTouchBarTab: string | null = null;

// Native macOS menu-bar flash (AppKit key-equivalent paint of the top-level
// title + leaf item). Sources: hotkey, MIDI, native menu click, SPA
// lastActionNonce.
//
// Menu.setApplicationMenu() tears down the NSMenu hierarchy and cancels an
// in-flight flash, so: (1) never rebuild the menu for lastAction-only
// updates, and (2) always fire the flash on the next macrotask.
let lastFlashedAction = "";
let lastFlashAt = 0;
let pendingFlashTitle: string | null = null;
let pendingFlashItem: string | null = null;
let pendingFlashTimer: ReturnType<typeof setTimeout> | null = null;

/** Top-level section title + leaf item title for a performAction id. */
function menuLocationForAction(
  action: string,
): { section: string; item: string } | null {
  if (!menuModel) return null;
  for (const section of menuModel.menus ?? []) {
    for (const it of section.items ?? []) {
      if (it.actionId === action && it.title)
        return { section: section.title, item: it.title };
    }
  }
  return null;
}

/** Prefer the live Electron menu label (matches NSApp.mainMenu titles). */
function resolveLiveMenuTitle(modelTitle: string): string {
  const menu = Menu.getApplicationMenu();
  if (!menu) return modelTitle;
  const exact = menu.items.find((it) => it.label === modelTitle);
  if (exact?.label) return exact.label;
  const ci = menu.items.find(
    (it) =>
      typeof it.label === "string" &&
      it.label.toLowerCase() === modelTitle.toLowerCase(),
  );
  if (ci?.label) return ci.label;
  // App menu is often the process name while the model says "ResoStage".
  if (modelTitle === "ResoStage" && menu.items[0]?.label)
    return menu.items[0].label;
  return modelTitle;
}

function scheduleMenuFlash(sectionTitle: string, itemTitle: string): void {
  pendingFlashTitle = sectionTitle;
  pendingFlashItem = itemTitle;
  if (pendingFlashTimer) clearTimeout(pendingFlashTimer);
  // Next macrotask: after any setApplicationMenu from this turn has settled.
  pendingFlashTimer = setTimeout(() => {
    pendingFlashTimer = null;
    const section = pendingFlashTitle;
    const item = pendingFlashItem;
    pendingFlashTitle = null;
    pendingFlashItem = null;
    if (!section) return;
    const live = resolveLiveMenuTitle(section);
    const flash = EnsureNativeMenuFlash();
    if (!flash) {
      console.warn("MenuFlash: native dylib not loaded");
      return;
    }
    flash(live, item ?? "");
  }, 16);
}

function flashMenuAction(action: string): void {
  if (!action) return;
  // open_recent:… etc. never appear as a single menu item id — skip noise.
  if (action.includes(":")) return;
  // Debounce identical back-to-back flashes (menu click + WS lastAction).
  const now = Date.now();
  if (action === lastFlashedAction && now - lastFlashAt < 250) return;
  lastFlashedAction = action;
  lastFlashAt = now;

  const loc = menuLocationForAction(action);
  if (!loc) return;
  scheduleMenuFlash(loc.section, loc.item);
}

async function postAction(action: string): Promise<boolean> {
  // Flash for menu-click / shell-originated actions (don't wait for the
  // SPA's WebSocket round-trip of lastActionNonce). Deferred so it lands
  // after any concurrent refreshMenu from menu-state.
  flashMenuAction(action);
  try {
    const res = await fetch(`${BACKEND}/api/v1/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchMenuWithRetry(
  tries = 20,
  delayMs = 300,
): Promise<MenuModel | null> {
  for (let i = 0; i < tries; ++i) {
    try {
      const res = await fetch(`${BACKEND}/api/v1/ui/menu`);
      if (res.ok) return (await res.json()) as MenuModel;
    } catch {
      // backend not up yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// "cmd + shift + s" → Electron accelerator "CommandOrControl+Shift+S".
function acceleratorFor(binding: string | undefined): string | undefined {
  if (!binding) return undefined;
  const tokens = binding.split("+").map((t) => t.trim());
  const acc: string[] = [];
  let key = "";
  for (const t of tokens) {
    if (t === "cmd") acc.push("CommandOrControl");
    else if (t === "ctrl") acc.push("Control");
    else if (t === "alt") acc.push("Alt");
    else if (t === "shift") acc.push("Shift");
    else key = t;
  }
  if (!key) return undefined;
  key = NAMED_KEYS[key] ?? key;
  return acc.concat(key).join("+");
}

const NAMED_KEYS: Record<string, string> = {
  space: "Space",
  escape: "Esc",
  return: "Enter",
  tab: "Tab",
  delete: "Delete",
  backspace: "Backspace",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  "page up": "PageUp",
  "page down": "PageDown",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
};

function keybindingFor(action: string): string {
  return menuModel?.keybindings?.[action] ?? "";
}

function buildMenuItem(item: MenuItemModel): MenuItemConstructorOptions {
  if (item.separator) return { type: "separator" };
  if (item.kind === "open-recent") {
    const recents = menuState.recentProjects ?? [];
    const items: MenuItemConstructorOptions[] = recents.length
      ? [
          ...recents.map(
            (rp): MenuItemConstructorOptions => ({
              label: rp.displayName || rp.path,
              click: () => void postAction(`open_recent:${rp.path}`),
            }),
          ),
          { type: "separator" },
          {
            label: "Clear Menu",
            click: () => void postAction("clear_recent_projects"),
          },
        ]
      : [{ label: "No Recent Projects", enabled: false }];
    return { label: item.title, submenu: items };
  }
  if (item.role === "about") return { role: "about", label: item.title };
  if (item.role === "minimize") return { role: "minimize", label: item.title };
  if (item.role === "zoom") return { role: "zoom", label: item.title };

  const action = item.actionId;
  if (!action) return { label: item.title ?? "" };
  if (action === "quit") {
    // Routed through the backend so the unsaved-changes prompt runs (the
    // JUCE process performs the actual quit and then kills this shell).
    return {
      label: item.title ?? "",
      accelerator: acceleratorFor(item.key),
      click: () => postAction("quit"),
    };
  }
  if (item.dynamicKey) {
    // These follow user keybindings and most are bare typing characters
    // (n, p, [, ]…) that must keep working inside text inputs, so the
    // accelerator is DISPLAYED only (registerAccelerator: false) -- the SPA
    // handles them in-page (see useGlobalHotkeys in App.tsx) and we dispatch
    // menu clicks via POST /api/v1/action.
    const binding = keybindingFor(action);
    return {
      label: item.title ?? "",
      accelerator: acceleratorFor(binding),
      registerAccelerator: false,
      enabled:
        action === "undo"
          ? menuState.canUndo
          : action === "redo"
            ? menuState.canRedo
            : true,
      click: () => void postAction(action),
    };
  }
  // Fixed app shortcuts (New / Open / Save / Save As / Minimize …): safe to
  // register as real accelerators -- none are bare typing characters.
  return {
    label: item.title ?? "",
    accelerator: acceleratorFor(item.key),
    click: () => postAction(action),
  };
}

/** Shell-only Dev menu (not in backend MenuModel) — DevTools / reload / recover. */
function buildDevMenu(): MenuItemConstructorOptions {
  return {
    label: "Dev",
    submenu: [
      {
        label: "Reload",
        accelerator: "CmdOrControl+R",
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.reload();
        },
      },
      {
        label: "Force Reload",
        accelerator: "CmdOrControl+Shift+R",
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.reloadIgnoringCache();
        },
      },
      { type: "separator" },
      {
        label: "Toggle Developer Tools",
        accelerator: "Alt+Command+I",
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.toggleDevTools();
        },
      },
      {
        label: "Inspect Element at Center…",
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          const [w, h] = mainWindow.getContentSize();
          mainWindow.webContents.inspectElement(
            Math.floor(w / 2),
            Math.floor(h / 2),
          );
          if (!mainWindow.webContents.isDevToolsOpened())
            mainWindow.webContents.openDevTools({ mode: "detach" });
        },
      },
      { type: "separator" },
      {
        label: "Recover UI (after sleep / black screen)",
        click: () => {
          lastRecoverAt = 0; // bypass debounce
          recoverRenderer("menu");
        },
      },
      {
        label: "Open GPU Internals",
        click: () => {
          // Separate window so it doesn't replace the SPA.
          const win = new BrowserWindow({
            width: 960,
            height: 720,
            title: "GPU Internals",
          });
          void win.loadURL("chrome://gpu");
        },
      },
      { type: "separator" },
      {
        label: "Test Trackpad Haptic",
        click: () => {
          const fn = EnsureNativeHaptics();
          if (!fn) {
            console.warn("Haptics: not available");
            return;
          }
          fn(1); // alignment
          setTimeout(() => fn(0), 120);
          setTimeout(() => fn(2), 240);
        },
      },
      {
        label: "Test Menu Flash (File → Save)",
        click: () => {
          scheduleMenuFlash("File", "Save");
        },
      },
    ],
  };
}

// Standard macOS text-editing roles (cut/copy/paste/selectAll/…). On macOS,
// Electron only wires up the Cmd+A / Cmd+C / Cmd+V / Cmd+X accelerators for
// focused web-content text fields when a menu item with the matching `role`
// exists SOMEWHERE in the application menu — this is not automatic just
// because a native <input> is focused, and it is not covered by the
// backend's cross-platform MenuModel (which only knows about app-level
// actions like the project undo stack, not native OS text editing). Without
// this, renaming anything — a light track, a project name, any text field —
// silently can't be select-all'd via Cmd+A. See Electron's "roles" docs.
function editRoleItems(): MenuItemConstructorOptions[] {
  return [
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "pasteAndMatchStyle" },
    { role: "delete" },
    { role: "selectAll" },
  ];
}

function buildMenu(): Menu | null {
  if (!menuModel) return null;
  const sections: MenuItemConstructorOptions[] = (menuModel.menus ?? []).map(
    (section) => ({
      label: section.title,
      submenu: (section.items ?? []).map((it) => buildMenuItem(it)),
    }),
  );
  const editIdx = sections.findIndex((s) => s.label === "Edit");
  if (editIdx >= 0) {
    const edit = sections[editIdx];
    const submenu = Array.isArray(edit.submenu) ? edit.submenu : [];
    edit.submenu = [...submenu, ...editRoleItems()];
  } else {
    sections.push({ label: "Edit", submenu: editRoleItems() });
  }
  // Insert Dev before Window (or append if Window is missing).
  const winIdx = sections.findIndex((s) => s.label === "Window");
  if (winIdx >= 0) sections.splice(winIdx, 0, buildDevMenu());
  else sections.push(buildDevMenu());
  return Menu.buildFromTemplate(sections);
}

/**
 * Unstick a frozen/black Chromium compositor after sleep, minimize, or long
 * occlusion. Always automatic (focus/show/power-resume) — Dev → Recover UI
 * is the same path, not a special mode.
 */
let lastRecoverAt = 0;
function recoverRenderer(
  reason: string,
  opts: { forceReload?: boolean } = {},
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const now = Date.now();
  // Debounce focus/show spam; power-resume uses a longer second pass.
  if (!opts.forceReload && now - lastRecoverAt < 350) return;
  lastRecoverAt = now;

  const wc = mainWindow.webContents;
  if (wc.isDestroyed()) return;

  if (opts.forceReload) {
    wc.reloadIgnoringCache();
    return;
  }

  // Re-assert live policy (Electron can re-enable throttling on some paths).
  try {
    wc.setBackgroundThrottling(false);
  } catch {
    /* older electron */
  }

  // Nudge the compositor after GPU sleep (black surface).
  try {
    const [w, h] = mainWindow.getSize();
    if (w > 0 && h > 0) {
      mainWindow.setSize(w, h + 1);
      mainWindow.setSize(w, h);
    }
  } catch {
    /* ignore */
  }

  // Prefer IPC (preload always receives it); executeJavaScript as fallback
  // for reflow if the page is mid-paint.
  try {
    wc.send("shell-resume", { reason });
  } catch {
    /* ignore */
  }
  void wc
    .executeJavaScript(
      `(() => {
        try {
          const b = document.body;
          if (b) {
            const prev = b.style.display;
            b.style.display = 'none';
            void b.offsetHeight;
            b.style.display = prev || '';
          }
          window.dispatchEvent(new CustomEvent('resoshell-resume', {
            detail: { reason: ${JSON.stringify(reason)} }
          }));
        } catch (e) {}
        true;
      })()`,
    )
    .catch(() => {
      /* renderer may be mid-navigation */
    });
}

function refreshMenu(): void {
  const menu = buildMenu();
  if (menu) Menu.setApplicationMenu(menu);
}

function buildTouchBar(): TouchBar | undefined {
  const tabs = menuModel?.touchbar ?? [];
  if (!tabs.length) return undefined;
  const buttons = tabs.map(
    (t) =>
      new TouchBarButton({
        label: t.label,
        backgroundColor: t.id === menuState.uiTab ? "#3b6cff" : undefined,
        click: () => postAction(`mode_${t.id}`),
      }),
  );
  return new TouchBar({ items: buttons });
}

function refreshTouchBar(): void {
  if (!mainWindow || !menuModel) return;
  if (menuState.uiTab === lastTouchBarTab) return;
  lastTouchBarTab = menuState.uiTab;
  const bar = buildTouchBar();
  if (bar) mainWindow.setTouchBar(bar);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: "ResoStage",
    backgroundColor: "#000000",
    // Don't paint a frozen black buffer while occluded — redraw on reveal.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Default off: rAF/timers must keep firing when minimized/occluded
      // (live meters, playhead, stage preview). See applyLiveRendererDefaults.
      backgroundThrottling: false,
    },
  });
  // API mirror of webPreferences.backgroundThrottling (some Electron builds
  // only honor the runtime setter after the window exists).
  try {
    mainWindow.webContents.setBackgroundThrottling(false);
  } catch {
    /* ignore */
  }

  // Only a MAIN-FRAME failure is worth falling back for, and only once. This
  // used to fire for any failed load in the page -- a missing favicon, an
  // aborted fetch, a navigation the user cancelled -- and yank the whole
  // window over to the embedded build mid-session.
  let triedEmbed = false;
  mainWindow.webContents.on(
    "did-fail-load",
    (_e, errorCode, _desc, _url, isMainFrame) => {
      // -3 is ERR_ABORTED: a load we superseded ourselves, not a failure.
      if (!isMainFrame || errorCode === -3 || triedEmbed) return;
      triedEmbed = true;
      void mainWindow?.loadURL(EMBED_URL);
    },
  );

  // Window close button goes through the same unsaved-changes prompt as the
  // Quit menu item (POST /api/v1/action "quit"). Only hard-close when the
  // backend is unreachable -- i.e. the JUCE process is already gone.
  let forceQuit = false;
  mainWindow.on("close", (e) => {
    if (forceQuit) return;
    e.preventDefault();
    void postAction("quit").then((ok) => {
      if (!ok) {
        forceQuit = true;
        app.quit();
      }
    });
  });

  // The Touch Bar's highlighted tab follows the SPA's live uiTab via
  // menu-state, but build the bar (with the latest known tab) as soon as the
  // window exists so nothing shows up empty/control-strip on first open.
  refreshTouchBar();
  mainWindow.on("focus", () => {
    refreshTouchBar();
    recoverRenderer("focus");
  });
  mainWindow.on("show", () => recoverRenderer("show"));
  mainWindow.on("restore", () => recoverRenderer("restore"));

  // Decide BEFORE loading rather than loading the dev URL and letting it fail:
  // that failure was a visible flash of Chromium's error page on every launch
  // without a dev server, and it burned a real navigation to discover
  // something a refused connection answers instantly.
  if (DEV_UI === "off") {
    void mainWindow.loadURL(EMBED_URL);
    return;
  }
  void findDevServer(DEV_UI === "wait" ? 10_000 : 0).then((up) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    console.log(
      up
        ? `[resostage] using the Vite dev server on :${DEV_PORT} (HMR live)`
        : `[resostage] no dev server on :${DEV_PORT} -- using the embedded UI build` +
            ` (RESOSTAGE_UI_DEV=wait to wait for one)`,
    );
    void mainWindow.loadURL(up ? DEV_URL : EMBED_URL);
  });
}

ipcMain.on("menu-state", (_event, s: Partial<MenuState>) => {
  if (s && typeof s === "object") {
    const prev = menuState;
    const prevNonce = prev.lastActionNonce;
    menuState = { ...menuState, ...s };
    if (mainWindow) {
      mainWindow.setTitle(
        s.projectName ? `ResoStage — ${s.projectName}` : "ResoStage",
      );
    }

    // Rebuild the NSMenu only when something that *appears* in it changes.
    // lastAction/nonce alone must NOT call setApplicationMenu — that tears
    // down the menu hierarchy and kills the native bar flash mid-paint.
    const needsMenuRebuild =
      prev.canUndo !== menuState.canUndo ||
      prev.canRedo !== menuState.canRedo ||
      prev.undoLabel !== menuState.undoLabel ||
      prev.redoLabel !== menuState.redoLabel ||
      JSON.stringify(prev.recentProjects) !==
        JSON.stringify(menuState.recentProjects);
    if (needsMenuRebuild) refreshMenu();

    if (
      menuState.lastActionNonce !== prevNonce &&
      menuState.lastActionNonce !== 0 &&
      menuState.lastAction
    ) {
      // SPA / MIDI / backend-originated actions (hotkeys that never hit
      // postAction() in this process). Menu-click paths already flashed
      // optimistically in postAction — debounced inside flashMenuAction.
      flashMenuAction(menuState.lastAction);
    }
    refreshTouchBar();
  }
});

ipcMain.on("action", (_event, action: unknown) => {
  if (typeof action === "string" && action) postAction(action);
});

// SPA → trackpad haptic tick (clip/cue drag snap, etc). Fire-and-forget --
// deliberately .on/.send, not .invoke/.handle, so a rapid-fire drag gesture
// never waits on an IPC round trip.
ipcMain.on("haptic-feedback", (_event, pattern: unknown) => {
  const fn = EnsureNativeHaptics();
  if (!fn) return;
  const p = pattern === "levelChange" ? 2 : pattern === "generic" ? 0 : 1;
  fn(p);
});

// SPA → native context menu (mixer track menus, etc.). Returns chosen id
// or null when dismissed / cancelled. Checkbox items use Electron's native
// `type: "checkbox"` so the OS draws platform checkmarks (macOS NSMenu, etc.).
ipcMain.handle(
  "show-context-menu",
  async (
    event,
    payload: {
      items?: Array<
        | { type: "separator" }
        | {
            type: "item";
            id: string;
            label: string;
            danger?: boolean;
            disabled?: boolean;
            /** When boolean, render as a native checkbox menu item. */
            checked?: boolean;
          }
      >;
      x?: number;
      y?: number;
    },
  ): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const items = payload?.items ?? [];
    return await new Promise((resolve) => {
      let settled = false;
      const done = (id: string | null) => {
        if (settled) return;
        settled = true;
        resolve(id);
      };
      const template: MenuItemConstructorOptions[] = items.map((it) => {
        if (it.type === "separator") return { type: "separator" as const };
        const isCheckbox = typeof it.checked === "boolean";
        return {
          label: it.label,
          enabled: !it.disabled,
          ...(isCheckbox
            ? { type: "checkbox" as const, checked: it.checked }
            : {}),
          click: () => done(it.id),
        };
      });
      if (template.length === 0) {
        done(null);
        return;
      }
      const menu = Menu.buildFromTemplate(template);
      menu.popup({
        window: win ?? undefined,
        x: typeof payload.x === "number" ? Math.round(payload.x) : undefined,
        y: typeof payload.y === "number" ? Math.round(payload.y) : undefined,
        callback: () => done(null),
      });
    });
  },
);

app.setAboutPanelOptions({
  applicationName: "ResoStage",
  applicationVersion: "0.2.0",
});

void app.whenReady().then(async () => {
  if (STANDALONE) spawnBackend();
  ensureAppNotSuspended();
  // Load MenuFlash/Haptics dylibs once up front so first-use isn't silent.
  preloadNatives();

  // The GET response already carries the current Open Recent list, so the
  // submenu is correct on first open -- before any live menu-state IPC has
  // arrived from the SPA. fetchMenuWithRetry()'s retry loop also doubles as
  // the "wait for the backend to finish starting up" gate in standalone mode.
  menuModel = await fetchMenuWithRetry();
  if (menuModel) {
    menuState = {
      ...menuState,
      recentProjects: menuModel.recentProjects ?? [],
    };
  }
  refreshMenu();

  // No runtime dock.setIcon() workaround needed anymore: when launched as
  // the branded copy (electron/scripts/brand-mac-app.mjs), the bundle's own
  // Info.plist + electron.icns already carry the correct icon. When running
  // unbranded (`electron .` in dev), this intentionally shows the stock
  // Electron icon rather than a single-resolution PNG override.
  createWindow();

  // System sleep / display off → wake: GPU + compositor often leave a black
  // frame. Recover automatically (double-pass: GPU may not be ready at +50ms).
  const onSystemWake = (reason: string) => {
    lastRecoverAt = 0;
    setTimeout(() => recoverRenderer(reason), 80);
    setTimeout(() => {
      lastRecoverAt = 0;
      recoverRenderer(`${reason}-late`);
    }, 500);
  };
  powerMonitor.on("resume", () => onSystemWake("power-resume"));
  powerMonitor.on("unlock-screen", () => onSystemWake("unlock-screen"));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else {
      lastRecoverAt = 0;
      recoverRenderer("activate");
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

// Safety net: normally the backend exits itself (unsaved-changes prompt via
// postAction("quit")) and its "exit" handler above calls app.quit(); this
// covers any other path out of the app (Cmd+Q racing the prompt, a signal,
// etc.) so a standalone launch never leaves the backend running headless
// with no shell left to talk to it.
app.on("before-quit", () => {
  releaseAppSuspensionBlocker();
  if (STANDALONE) killBackend();
});
