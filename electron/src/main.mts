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
//
// Platform menu behavior:
//   * macOS   — global menu bar (top of screen)
//   * Windows — menu in window title bar (setMenu)
//   * Linux   — detects global menu support (KDE/Unity); falls back to window menu

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  powerSaveBlocker,
  TouchBar,
  type MenuItemConstructorOptions,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import dgram from "node:dgram";
import path from "node:path";
import {
  createPlatformAdapter,
  type PlatformAdapter,
} from "./platform/index.js";

// All platform differences live behind the platform adapter (see platform/).
// main.mts talks to `platform` and never reads process.platform directly.
// The context is wired to module state as it comes into existence below;
// the object reference is stable, so the adapter always sees the latest state.
const platformContext = {
  appName: "ResoStage",
  getMainWindow: () => mainWindow,
  postAction: (action: string) => postAction(action),
};
const platform: PlatformAdapter = createPlatformAdapter(platformContext);

// ── Live-by-default (no user toggle) ──────────────────────────────────────
// Stage app: the UI must keep running when minimized, alt-tabbed, or under
// another window. Chromium's default is to background-throttle the renderer
// (timers, rAF, sometimes the GPU surface) — that's the black screen after
// wake. These are permanent defaults, not optional flags!
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

// IPC readiness gate (standalone only, where Electron spawns the Core backend).
// The Core backend, started with --ipc-socket <path>, creates a Unix domain
// socket (or Windows named pipe) and pushes {"type":"ready"} once the audio
// device is open. Connecting here is faster and more precise than polling the
// HTTP server, and avoids a visible window frame during backend startup.
function ipcSocketPath(): string {
  // Windows uses a named pipe (the Core prepends \\.\pipe\ itself); POSIX
  // uses a Unix-domain socket file. Both live behind the platform adapter.
  return platform.ipcSocketPath();
}

// Connects to the IPC socket and resolves when the backend sends {"type":"ready"}.
// Falls back to resolve on connection (message may already be queued server-side).
function waitForIpcReady(timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve) => {
    const p = ipcSocketPath();
    const sock: Socket = connect(p);
    const onData = (data: Buffer) => {
      // Core шлёт JSON‑строки с переводом строки. Дожидаемся ready или любого сообщения.
      const text = data.toString();
      if (text.includes('"type":"ready"')) {
        sock.off("data", onData);
        sock.end();
        resolve();
      }
    };
    sock.on("connect", () => {
      sock.on("data", onData);
    });
    sock.on("error", () => resolve());
    setTimeout(() => {
      if (!sock.destroyed) sock.end();
      resolve(); // fallback — UI падает на HTTP polling, как раньше
    }, timeoutMs).unref?.();
  });
}

const UDP_TELEMETRY_PORT = 2898;
let udpTelemetrySocket: dgram.Socket | null = null;

function setupUdpTelemetry(): void {
  try {
    if (udpTelemetrySocket) return;
    udpTelemetrySocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    udpTelemetrySocket.on("message", (msg: Buffer) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("udp-telemetry", msg);
      }
    });
    udpTelemetrySocket.bind(UDP_TELEMETRY_PORT, "127.0.0.1", () => {
      console.log(`[resostage] UDP Telemetry listener bound to 127.0.0.1:${UDP_TELEMETRY_PORT}`);
    });
  } catch (err) {
    console.warn("[resostage] UDP telemetry listener failed:", err);
  }
}

// Send a JSON message to the Core backend via IPC socket.
// Returns a promise that resolves when the message is written (or fails).
function sendIpcMessage(msg: object): Promise<boolean> {
  return new Promise((resolve) => {
    const p = ipcSocketPath();
    const sock: Socket = connect(p);
    const data = JSON.stringify(msg) + "\n";
    sock.on("connect", () => {
      sock.write(data, () => {
        sock.end();
        resolve(true);
      });
    });
    sock.on("error", () => resolve(false));
    setTimeout(() => {
      if (!sock.destroyed) sock.end();
      resolve(false);
    }, 2000).unref?.();
  });
}

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
  /** The theme's accent as a hex, forwarded by the page. */
  accentColor: string;
  projectName: string;
  lastAction: string;
  lastActionNonce: number;
  /** Live transport state -- the idle policy's absolute override. */
  playing: boolean;
  saveAsPending?: boolean;
}

function backendPort(): number {
  const arg = process.argv.find((a) => a.startsWith("--backend-port="));
  const n = arg ? Number(arg.split("=")[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT;
}

function remoteTarget(): string | null {
  const arg = process.argv.find((a) => a.startsWith("--remote="));
  return arg ? arg.split("=")[1] : null;
}

const PORT = backendPort();
const REMOTE = remoteTarget();
// If --remote is provided, we're in remote mode: connect to remote Core
// instead of spawning local one. STANDALONE is effectively false.
const IS_REMOTE = REMOTE !== null;
const BACKEND = IS_REMOTE ? `http://${REMOTE}:${PORT}` : `http://localhost:${PORT}`;
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
const STANDALONE = !IS_REMOTE && !process.argv.some((a) => a.startsWith("--backend-port="));
let backendProcess: ChildProcess | null = null;

function findNestedCoreBinary(): string | null {
  // Bundle layout is platform-specific (macOS .app bundle vs Windows/Linux
  // bare executable) — handled by the platform adapter.
  return platform.findNestedCoreBinary();
}

function spawnBackend(): void {
  // A Core that outlived a killed/crashed shell (or an old build) still binds
  // :2899 and serves the SPA's .js as text/html -> black window. With the
  // single-instance lock held we know no other app instance is legitimately
  // running, so on Windows we clear any leftover "ResoStage Core.exe" before
  // spawning ours. (macOS shells the Core inside the app bundle; the OS reaps
  // strays with the parent.)
  platform.cleanupBeforeBackendSpawn();
  const corePath = findNestedCoreBinary();
  if (!corePath) {
    console.error(
      "Standalone launch but no nested ResoStage Core.app found -- cannot start backend",
    );
    return;
  }
  // Передаём путь IPC‑сокета: Core сообщит о готовности по нему раньше,
  // чем станет доступен HTTP, чтобы Electron не показывал окно в пустоту.
  const ipcPath = ipcSocketPath();
  try {
    unlinkSync(ipcPath);
  } catch {
    /* нет старого сокета — ок */
  }
  console.log(`[resostage] Spawning nested backend: ${corePath}`);
  backendProcess = spawn(
    corePath,
    ["--ipc-socket", ipcPath],
    {
      env: { ...process.env, RESOSTAGE_SPAWNED_BY_SHELL: "1" },
      stdio: "pipe",
    },
  );
  backendProcess.stdout?.on("data", (d) =>
    console.log(`[core stdout] ${d.toString().trim()}`),
  );
  backendProcess.stderr?.on("data", (d) =>
    console.error(`[core stderr] ${d.toString().trim()}`),
  );
  backendProcess.on("error", (err) => {
    console.error("[resostage] backendProcess error:", err);
  });
  backendProcess.on("exit", (code, signal) => {
    console.warn(
      `[resostage] Core process exited (code=${code}, signal=${signal})`,
    );
    backendProcess = null;
    isQuitting = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.destroy();
      } catch {
        /* ignore */
      }
      mainWindow = null;
    }
    app.quit();
  });
}

function killBackend(): void {
  if (backendProcess && !backendProcess.killed) {
    try {
      backendProcess.kill();
    } catch {
      /* ignore */
    }
  }
  backendProcess = null;
  platform.cleanupAfterBackendKill();
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
  accentColor: "",
  projectName: "",
  lastAction: "",
  lastActionNonce: 0,
  playing: false,
};
let lastTouchBarTab: string | null = null;
let isSaveDialogActive = false;

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
    platform.flashMenuItem(live, item ?? "");
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

async function handleFileDialogAction(action: string): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const isMac = process.platform === "darwin";

  if (action === "open_project") {
    // On macOS, passing strict extensions in filters causes NSOpenPanel to
    // grey out project directories that Finder sees as public.folder.
    // Omitting filters on macOS and passing ['openFile', 'openDirectory']
    // allows selecting .rsnraset package folders, .rsnrasetmeta files, or any
    // project directory natively without anything being greyed out.
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Open ResoStage Project",
      ...(isMac
        ? {}
        : {
            filters: [
              {
                name: "ResoStage Project",
                extensions: ["rsnraset", "rsnrasetmeta"],
              },
              { name: "All Files", extensions: ["*"] },
            ],
          }),
      properties: ["openFile", "openDirectory"],
    });
    if (!res.canceled && res.filePaths[0]) {
      return postAction(`open_path:${res.filePaths[0]}`);
    }
    return true;
  }

  if (action === "save_project_as") {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: "Save ResoStage Project As",
      defaultPath: "UntitledProject.rsnraset",
      filters: [{ name: "ResoStage Project", extensions: ["rsnraset"] }],
      showsTagField: false,
    });
    if (!res.canceled && res.filePath) {
      return postAction(`save_as_path:${res.filePath}`);
    }
    void postAction("cancel_save_as");
    return true;
  }

  if (action === "import_song_folder") {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Import Song Folder",
      properties: ["openDirectory"],
    });
    if (!res.canceled && res.filePaths[0]) {
      return postAction(`import_song_folder_path:${res.filePaths[0]}`);
    }
    return true;
  }

  return false;
}

async function postAction(action: string): Promise<boolean> {
  // Flash for menu-click / shell-originated actions (don't wait for the
  // SPA's WebSocket round-trip of lastActionNonce). Deferred so it lands
  // after any concurrent refreshMenu from menu-state.
  flashMenuAction(action);

  if (
    action === "open_project" ||
    action === "save_project_as" ||
    action === "import_song_folder"
  ) {
    const handled = await handleFileDialogAction(action);
    if (handled) return true;
  }

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

/**
 * Whether the page currently has a text field focused.
 *
 * The renderer tells us, because the main process cannot see focus inside the
 * document. Without it, binding "n" to Next Song would make the letter n
 * unusable in every name field in the app.
 */
let typingFocus = false;

/**
 * Electron's `input.key` for a binding token, lowercased.
 *
 * The binding strings come from JUCE (`KeyPress::createFromDescription`) and
 * name a few keys differently from the DOM, so the two vocabularies meet here
 * rather than in a dozen comparisons.
 */
const INPUT_KEY_ALIASES: Record<string, string[]> = {
  space: [" ", "spacebar"],
  escape: ["escape", "esc"],
  return: ["enter", "return"],
  enter: ["enter", "return"],
  tab: ["tab"],
  delete: ["delete"],
  backspace: ["backspace"],
  up: ["arrowup"],
  down: ["arrowdown"],
  left: ["arrowleft"],
  right: ["arrowright"],
  home: ["home"],
  end: ["end"],
};

/** Does this key event match a binding like "cmd + shift + s" / "space" / "n"? */
function inputMatchesBinding(
  input: Electron.Input,
  binding: string | undefined,
): boolean {
  if (!binding) return false;
  const tokens = binding
    .split("+")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return false;

  let wantCmd = false;
  let wantCtrl = false;
  let wantAlt = false;
  let wantShift = false;
  let key = "";
  for (const t of tokens) {
    if (t === "cmd" || t === "command") wantCmd = true;
    else if (t === "ctrl" || t === "control") wantCtrl = true;
    else if (t === "alt" || t === "option") wantAlt = true;
    else if (t === "shift") wantShift = true;
    else key = t;
  }
  if (!key) return false;

  // "cmd" is CommandOrControl, matching how the menu displays it: Command on
  // macOS, Control everywhere else. A binding that says "ctrl" outright means
  // Control on every platform.
  const cmdHeld = platform.commandIsMeta ? input.meta : input.control;
  if (wantCmd !== cmdHeld) return false;
  if (wantCtrl && !input.control) return false;
  if (wantAlt !== input.alt) return false;
  if (wantShift !== input.shift) return false;
  // A binding with no modifiers must not fire while one is held -- ⌘N is New
  // Project, not Next Song.
  if (!wantCmd && !wantCtrl && (input.meta || input.control)) return false;

  const pressed = (input.key ?? "").toLowerCase();
  const accepted = INPUT_KEY_ALIASES[key] ?? [key];
  return accepted.includes(pressed);
}

/**
 * Dispatch keybindings from the shell instead of from the page.
 *
 * The page used to own every binding, which meant the shell never learned a
 * key had been pressed -- so the menu-bar flash that confirms an action only
 * ever fired when you clicked the menu item itself, never when you used its
 * shortcut. Handling them here fixes that at the source: the same postAction
 * path runs for a key and for a click, so they cannot behave differently.
 *
 * `before-input-event` is Chromium-level, so this is one implementation for
 * macOS, Windows and Linux rather than three. It only fires for the focused
 * webContents, and the explicit isFocused() check below covers the rest: a
 * background window must never eat a keystroke meant for whatever the user is
 * actually looking at.
 */
function installHotkeyHandler(win: BrowserWindow): void {
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    // Held keys must not machine-gun Next Song.
    if (input.isAutoRepeat) return;
    if (typingFocus) return;
    if (!win.isFocused()) return;

    const bindings = menuModel?.keybindings ?? {};
    for (const [action, binding] of Object.entries(bindings)) {
      if (!inputMatchesBinding(input, binding)) continue;
      event.preventDefault();
      void postAction(action);
      return;
    }
  });
}

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
        accelerator: "CommandOrControl+R",
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.webContents.reload();
        },
      },
      {
        label: "Force Reload",
        accelerator: "CommandOrControl+Shift+R",
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
          platform.hapticFeedback(1); // alignment
          setTimeout(() => platform.hapticFeedback(0), 120);
          setTimeout(() => platform.hapticFeedback(2), 240);
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

  // Platform-specific section adaptation (macOS keeps the app menu, Windows
  // and Linux fold it into File) — delegated to the platform adapter.
  platform.adaptMenuSections(sections as Parameters<PlatformAdapter["adaptMenuSections"]>[0]);

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

// ── Idle policy ───────────────────────────────────────────────────────────
//
// The live-by-default switches above are what let this app keep metering and
// previewing while it sits behind the DAW -- and they are also, on their own,
// a promise never to save any power at all. On a laptop that is not the right
// trade for the case where the window is put away and the transport is
// stopped: nothing is being watched and nothing is moving, but the renderer is
// still painting sixty frames a second and the process is still pinned out of
// App Nap.
//
// So the switches stay (they are the show-time guarantee) and this narrow,
// explicitly-gated policy sits on top:
//
//   idle  ⟺  the window is NOT on screen  AND  the transport is stopped
//            AND it has been that way for IDLE_AFTER_MS
//
// "Not on screen" means hidden or minimized -- NOT merely unfocused. A window
// the operator can see keeps running at full rate even while they work in
// another app, which is the whole point of the app. And `playing` is an
// absolute override: a hidden window mid-song is doing its job.
//
// Waking is deliberately not symmetric with sleeping. There is no delay and no
// debounce on the way back: the first show/focus/restore/activate event, or
// the transport starting, restores everything before the window has painted,
// so the operator never sees the UI catch up.
const IDLE_AFTER_MS = 30_000;

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let isIdle = false;
let transportPlaying = false;

function windowOnScreen(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    return mainWindow.isVisible() && !mainWindow.isMinimized();
  } catch {
    return true; // never guess "hidden" when we cannot tell
  }
}

function shouldBeIdle(): boolean {
  return !windowOnScreen() && !transportPlaying;
}

function sendToRenderer(channel: string, reason: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (wc.isDestroyed()) return;
  try {
    wc.send(channel, { reason });
  } catch {
    /* renderer may be mid-navigation */
  }
}

/**
 * Power / thermal state, pushed to the page so it can lower its frame budget.
 *
 * None of this is visible to the renderer on its own: `navigator.getBattery`
 * cannot see macOS Low Power Mode or Windows battery saver, and there is no
 * web API at all for thermal pressure. The page folds what arrives here into
 * the same auto-degrade ladder it already runs for CPU, disk and audio
 * underruns -- see ui/src/lib/powerState.ts.
 */
type ThermalState = "nominal" | "fair" | "serious" | "critical";

let lastPowerPayload = "";

function readThermalState(): ThermalState {
  try {
    // macOS only; other platforms have no equivalent and report nominal.
    const state = (
      powerMonitor as unknown as {
        getCurrentThermalState?: () => string;
      }
    ).getCurrentThermalState?.();
    if (
      state === "nominal" ||
      state === "fair" ||
      state === "serious" ||
      state === "critical"
    ) {
      return state;
    }
  } catch {
    /* not supported on this platform / electron build */
  }
  return "nominal";
}

function publishPowerState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (wc.isDestroyed()) return;

  let onBattery = false;
  try {
    onBattery = powerMonitor.isOnBatteryPower();
  } catch {
    /* desktops report nothing */
  }
  const thermal = readThermalState();
  // Windows raises speed-limit-change when battery saver clamps the CPU;
  // macOS Low Power Mode shows up as thermal pressure plus battery. Treating
  // "on battery and throttled" as the saver covers both without a per-OS API.
  const powerSaver = onBattery && thermal !== "nominal";

  const payload = { onBattery, powerSaver, thermal };
  const key = JSON.stringify(payload);
  if (key === lastPowerPayload) return; // the page dedups too; save the IPC
  lastPowerPayload = key;
  try {
    wc.send("shell-power", payload);
  } catch {
    /* renderer may be mid-navigation */
  }
}

function enterIdle(reason: string): void {
  if (isIdle || !mainWindow || mainWindow.isDestroyed()) return;
  isIdle = true;
  // Tell the page first: it stands its own animation loops down, which is
  // where nearly all of the cost actually is.
  sendToRenderer("shell-idle", reason);
  try {
    mainWindow.webContents.setBackgroundThrottling(true);
  } catch {
    /* older electron */
  }
  // Let the OS suspend/nap this process. The JUCE backend is a separate
  // process and keeps the audio and the lighting rig running regardless.
  releaseAppSuspensionBlocker();
}

function exitIdle(reason: string): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!isIdle) return;
  isIdle = false;
  ensureAppNotSuspended();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.setBackgroundThrottling(false);
    } catch {
      /* older electron */
    }
  }
  sendToRenderer("shell-active", reason);
}

/** Re-decide after anything that could change visibility or transport state. */
function reevaluateIdle(reason: string): void {
  if (!shouldBeIdle()) {
    exitIdle(reason);
    return;
  }
  if (isIdle || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // Conditions are re-checked at the deadline, never assumed to still hold.
    if (shouldBeIdle()) enterIdle(reason);
  }, IDLE_AFTER_MS);
}

/**
 * Apply menu to the appropriate location based on platform:
 * - macOS: global menu bar (Menu.setApplicationMenu)
 * - Windows: window menu bar (mainWindow.setMenu)
 * - Linux: Electron auto-detects D-Bus com.canonical.AppMenu.Registrar;
 *          we attempt setApplicationMenu first (works in KDE/Unity/etc),
 *          fallback to window menu if environment suggests no global menu support
 */
/**
 * Register the .rsnrasetmeta file association under HKEY_CURRENT_USER so
 * double-clicking a project file opens it, even for the portable build that
 * never ran the Inno installer (which writes the same keys under HKCR). HKCU
 * needs no elevation and does not require a reinstall when the app moves.
 * Best-effort: a failure to write is non-fatal.
 */
function registerFileAssociations(): void {
  platform.registerFileAssociations();
}

function refreshMenu(): void {
  const menu = buildMenu();
  if (!menu) return;
  // Platform-appropriate menu surface (global bar on mac/Linux, window title
  // bar on Windows) — delegated to the platform adapter.
  platform.applyMenu(menu);
}

function buildTouchBar(): TouchBar | undefined {
  const tabs = menuModel?.touchbar ?? [];
  const uiTab = menuState.uiTab || "";
  const accent = menuState.accentColor || "";
  return platform.buildTouchBar(tabs, uiTab, accent);
}

function refreshTouchBar(): void {
  if (!mainWindow || !menuModel) return;
  // Keyed on the accent too: switching theme has to repaint the active
  // button, and the tab has not changed when it does.
  const key = `${menuState.uiTab}|${menuState.accentColor}`;
  if (key === lastTouchBarTab) return;
  lastTouchBarTab = key;
  const bar = buildTouchBar();
  if (bar) mainWindow.setTouchBar(bar);
}

function createWindow(): void {
  platform.installTray();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: "ResoStage",
    backgroundColor: "#09090b",
    // Don't paint a frozen black buffer while occluded — redraw on reveal.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Default off: rAF/timers must keep firing when minimized/occluded
      // (live meters, playhead, stage preview). See applyLiveRendererDefaults.
      // The idle policy flips this on only while the window is genuinely away
      // and the transport is stopped.
      backgroundThrottling: false,
      // Nothing in this UI is prose. The spell checker otherwise downloads and
      // holds a dictionary and runs over every text field for no benefit.
      spellcheck: false,
    },
  });

  // Keybindings are dispatched here rather than in the page -- see
  // installHotkeyHandler for why, and for the focus rules.
  installHotkeyHandler(mainWindow);
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

  // Window close button: send "quit" action to backend so it prompts for unsaved
  // changes if dirty, saves/cancels appropriately, and quits Core + Electron.
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    void postAction("quit");
  });

  // The Touch Bar's highlighted tab follows the SPA's live uiTab via
  // menu-state, but build the bar (with the latest known tab) as soon as the
  // window exists so nothing shows up empty/control-strip on first open.
  refreshTouchBar();
  // Wake FIRST, then recover: exitIdle re-enables the renderer and re-acquires
  // the suspension blocker, so the reflow/compositor nudge recoverRenderer
  // does lands on a window that is already allowed to paint at full rate.
  mainWindow.on("focus", () => {
    exitIdle("focus");
    refreshTouchBar();
    recoverRenderer("focus");
  });
  mainWindow.on("show", () => {
    exitIdle("show");
    recoverRenderer("show");
  });
  mainWindow.on("restore", () => {
    exitIdle("restore");
    recoverRenderer("restore");
  });
  // The only paths INTO idle. Both are re-checked at the deadline, so a
  // hide/show inside the delay window never sleeps the app.
  mainWindow.on("hide", () => reevaluateIdle("hide"));
  mainWindow.on("minimize", () => reevaluateIdle("minimize"));

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

// The page tells us when a text field has focus, so bare-letter bindings
// ("n" for Next Song) do not eat characters while someone is naming a track.
ipcMain.on("typing-focus", (_event, focused: boolean) => {
  typingFocus = Boolean(focused);
});

ipcMain.on("menu-state", (_event, s: Partial<MenuState>) => {
  if (s && typeof s === "object") {
    const prev = menuState;
    const prevNonce = prev.lastActionNonce;
    menuState = { ...menuState, ...s };
    if (typeof s.playing === "boolean" && s.playing !== transportPlaying) {
      transportPlaying = s.playing;
      // Starting playback while hidden must cancel a pending sleep (and undo
      // one already taken) immediately -- reevaluateIdle handles both.
      reevaluateIdle(s.playing ? "transport-play" : "transport-stop");
    }
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
    if (menuState.saveAsPending && !isSaveDialogActive) {
      isSaveDialogActive = true;
      void handleFileDialogAction("save_project_as").then(() => {
        isSaveDialogActive = false;
      });
    }
    refreshTouchBar();
  }
});

ipcMain.on("action", (_event, action: unknown) => {
  if (action === "quit-approved") {
    void postAction("quit");
    return;
  }
  if (typeof action === "string" && action) postAction(action);
});

// SPA → trackpad haptic tick (clip/cue drag snap, etc). Fire-and-forget --
// deliberately .on/.send, not .invoke/.handle, so a rapid-fire drag gesture
// never waits on an IPC round trip.
ipcMain.on("haptic-feedback", (_event, pattern: unknown) => {
  const p = pattern === "levelChange" ? 2 : pattern === "generic" ? 0 : 1;
  platform.hapticFeedback(p);
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

// Set once a real quit is under way (menu Quit -> backend exits -> we call
// app.quit()). The window "close" handler uses it to distinguish "user closed
// the window" (hide + keep backend alive, macOS-style) from "we are actually
// quitting" (let the window go). Without this, backend-exit's app.quit() gets
// swallowed by a close handler that keeps preventDefault()-ing -- the "first
// close kills Core, only a second close quits the shell" bug on Windows.
let isQuitting = false;
let pendingOpenProjectPath: string | null = null;
let backendReady = false;

// Register open-file event listener IMMEDIATELY at module load time on macOS.
// Finder emits open-file before app.whenReady() during cold launch when a user
// double-clicks a .rsnraset / .rsnrasetmeta file.
if (process.platform === "darwin") {
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (filePath) {
      pendingOpenProjectPath = filePath;
      if (backendReady) {
        void handleOpenProjectFile(filePath);
      }
    }
  });
}

// Forward an opened project file to the backend. Defined at module scope so
// both the macOS open-file handler and the single-instance second-instance
// event can reach it. The backend itself decides whether to prompt to save
// the current dirty project first.
async function handleOpenProjectFile(filePath: string): Promise<void> {
  if (!filePath) return;
  pendingOpenProjectPath = filePath;

  // Try IPC socket first (fastest, direct C++ message).
  const sent = await sendIpcMessage({ type: "open-project", path: filePath });
  if (!sent) {
    // Fallback if IPC socket connection fails/isn't ready: send via REST action.
    await postAction(`open_path:${filePath}`);
  }
}

// Only one ResoStage instance may run at a time (macOS + Windows). A second
// launch forwards its open-project argv to the running instance and quits,
// instead of spawning a second Core that would fight over :2899 (and, with a
// stale backend, serve the SPA's .js as text/html -- the black screen).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const fileArg = argv.find((a) => {
      const clean = a.replace(/^"+|"+$/g, "");
      return (
        clean.endsWith(".rsnrasetmeta") ||
        clean.endsWith(".rsnraset") ||
        clean.endsWith("project.rsnrasetmeta")
      );
    });
    if (fileArg) {
      const cleanPath = fileArg.replace(/^"+|"+$/g, "");
      void handleOpenProjectFile(cleanPath);
    }
  });

  void app.whenReady().then(async () => {
    if (STANDALONE) spawnBackend();
    ensureAppNotSuspended();
    setupUdpTelemetry();
    // Load platform native libraries (MenuFlash/Haptics) once up front so
    // first-use isn't silent.
    platform.preloadNatives();

    // Handle file associations: .rsnrasetmeta / .rsnraset files opened via
    // Finder/Explorer. macOS delivers via app.on('open-file'); Windows/Linux
    // deliver the path via argv. Both behaviors live behind the platform adapter.
    platform.registerOpenFileHandler((filePath) => {
      void handleOpenProjectFile(filePath);
    });
    const fileArg = platform.handleProjectFileArgv(process.argv);
    if (fileArg) pendingOpenProjectPath = fileArg;

    // Ждём готовности IPC Core (standalone) — мгновенно, если сокет недоступен,
    // fallback на HTTP polling через fetchMenuWithRetry ниже.
    if (STANDALONE) await waitForIpcReady();

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

    backendReady = true;

    // Backend is 100% ready! If a project file was opened during cold launch,
    // forward it now to the backend.
    if (pendingOpenProjectPath) {
      const pathToOpen = pendingOpenProjectPath;
      console.log(`[resostage] Cold launch opening project: ${pathToOpen}`);
      void handleOpenProjectFile(pathToOpen);
    }

  // No runtime dock.setIcon() workaround needed anymore: when launched as
  // the branded copy (electron/scripts/brand-mac-app.mjs), the bundle's own
  // Info.plist + electron.icns already carry the correct icon. When running
  // unbranded (`electron .` in dev), this intentionally shows the stock
  // Electron icon rather than a single-resolution PNG override.
  createWindow();

  // On Windows the menu is attached to the BrowserWindow (mainWindow.setMenu),
  // which only exists once createWindow() has run -- refreshing before it
  // silently drops the menu bar until some undo/redo/recent change happens to
  // trigger a rebuild. macOS/Linux use the window-independent application menu.
  refreshMenu();

  // Register the .rsnrasetmeta association for the portable Windows build.
  registerFileAssociations();

  // System sleep / display off → wake: GPU + compositor often leave a black
  // frame. Recover automatically (double-pass: GPU may not be ready at +50ms).
  const onSystemWake = (reason: string) => {
    exitIdle(reason);
    lastRecoverAt = 0;
    setTimeout(() => recoverRenderer(reason), 80);
    setTimeout(() => {
      lastRecoverAt = 0;
      recoverRenderer(`${reason}-late`);
    }, 500);
  };
  powerMonitor.on("resume", () => onSystemWake("power-resume"));
  powerMonitor.on("unlock-screen", () => onSystemWake("unlock-screen"));

  // Power / thermal state. Event-driven where the platform offers events, with
  // a slow poll behind it because macOS reports entering Low Power Mode only
  // as a thermal-state change, and not always promptly.
  powerMonitor.on("on-battery", publishPowerState);
  powerMonitor.on("on-ac", publishPowerState);
  powerMonitor.on("speed-limit-change", publishPowerState);
  powerMonitor.on("thermal-state-change", publishPowerState);
  publishPowerState();
  setInterval(publishPowerState, 30_000).unref?.();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else {
      exitIdle("activate");
      lastRecoverAt = 0;
      recoverRenderer("activate");
    }
  });

  // Dock-hide / Cmd+H puts every window out of view without a per-window
  // "hide" on some platforms; app-level focus is the reliable signal that the
  // user is back regardless of which path took the window away.
  app.on("browser-window-focus", () => exitIdle("app-focus"));
  app.on("did-become-active", () => exitIdle("app-active"));
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

// Safety net: normally the backend exits itself (unsaved-changes prompt via
// postAction("quit")) and its "exit" handler above calls app.quit(); this
// covers any other path out of the app (Cmd+Q racing the prompt, a signal,
// etc.) so a standalone launch never leaves the backend running headless.
app.on("before-quit", (e) => {
  if (!isQuitting && STANDALONE && backendProcess && !backendProcess.killed) {
    e.preventDefault();
    void postAction("quit");

    // Generous fallback timeout (20s): if backend is performing a heavy save of WAV
    // stems on exit, give it full time to finish. Only force-kill if it hangs completely.
    setTimeout(() => {
      if (backendProcess && !backendProcess.killed && !isQuitting) {
        console.warn("[resostage] Backend shutdown timeout (20s) -- force killing process");
        isQuitting = true;
        releaseAppSuspensionBlocker();
        killBackend();
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.destroy();
          } catch {
            /* ignore */
          }
          mainWindow = null;
        }
        app.quit();
      }
    }, 20_000);
    return;
  }
  isQuitting = true;
  releaseAppSuspensionBlocker();
  if (STANDALONE) killBackend();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.destroy();
    } catch {
      /* ignore */
    }
    mainWindow = null;
  }
});
