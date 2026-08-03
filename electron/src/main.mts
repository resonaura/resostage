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
  type MenuItemConstructorOptions,
} from "electron";
import path from "node:path";
import { existsSync } from "node:fs";

const { TouchBarButton } = TouchBar;

// The on-screen product is "ResoStage" (JUCE stays headless as "ResoStage
// Core"). Electron would otherwise call itself "Electron" in the Dock/menu.
app.setName("ResoStage");

// Directory that holds this shell's package.json. Set by how Electron is
// launched: `electron <dir> --backend-port=…` from the JUCE core, or
// `electron .` (pnpm start) -- both resolve to the electron/ package dir.
const packageDir = path.resolve(process.argv[1] ?? ".");
const repoRoot = path.dirname(packageDir);

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
}

function backendPort(): number {
  const arg = process.argv.find((a) => a.startsWith("--backend-port="));
  const n = arg ? Number(arg.split("=")[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT;
}

const PORT = backendPort();
const BACKEND = `http://localhost:${PORT}`;
// Vite dev server first (live HMR while iterating), embedded assets fallback.
const DEV_URL = "http://localhost:2900/?embedded=1";
const EMBED_URL = `${BACKEND}/?embedded=1`;

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
};
let lastTouchBarTab: string | null = null;

async function postAction(action: string): Promise<boolean> {
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
      label: item.title,
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
    label: item.title,
    accelerator: acceleratorFor(item.key),
    click: () => postAction(action),
  };
}

function buildMenu(): Menu | null {
  if (!menuModel) return null;
  const sections = (menuModel.menus ?? []).map((section) => ({
    label: section.title,
    submenu: (section.items ?? []).map((it) => buildMenuItem(it)),
  }));
  return Menu.buildFromTemplate(sections);
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
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let triedEmbed = false;
  mainWindow.webContents.on("did-fail-load", () => {
    if (!triedEmbed) {
      triedEmbed = true;
      void mainWindow?.loadURL(EMBED_URL);
    }
  });

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
  mainWindow.on("focus", () => refreshTouchBar());

  void mainWindow.loadURL(DEV_URL);
}

ipcMain.on("menu-state", (_event, s: Partial<MenuState>) => {
  if (s && typeof s === "object") {
    menuState = { ...menuState, ...s };
    if (mainWindow) {
      mainWindow.setTitle(
        s.projectName ? `ResoStage — ${s.projectName}` : "ResoStage",
      );
    }
    refreshMenu();
    refreshTouchBar();
  }
});

ipcMain.on("action", (_event, action: unknown) => {
  if (typeof action === "string" && action) postAction(action);
});

app.setAboutPanelOptions({
  applicationName: "ResoStage",
  applicationVersion: "0.2.0",
});

void app.whenReady().then(async () => {
  // The GET response already carries the current Open Recent list, so the
  // submenu is correct on first open -- before any live menu-state IPC has
  // arrived from the SPA.
  menuModel = await fetchMenuWithRetry();
  if (menuModel) {
    menuState = { ...menuState, recentProjects: menuModel.recentProjects ?? [] };
  }
  refreshMenu();

  const iconPath = path.join(repoRoot, "icons", "app.png");
  if (existsSync(iconPath)) app.dock?.setIcon(iconPath);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
