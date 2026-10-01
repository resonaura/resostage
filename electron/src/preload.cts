/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// contextBridge API exposed to the SPA as window.resostageElectron.
//
// Must stay CommonJS (.cts → .cjs): the renderer runs sandboxed, and
// sandboxed preload scripts cannot use ES module imports.

import { contextBridge, ipcRenderer } from "electron";

let nextContextMenuRequestId = 1;
const pendingContextMenus = new Map<
  number,
  (id: string | null) => void
>();

ipcRenderer.on(
  "context-menu-result",
  (_event, payload: { requestId?: number; id?: string | null }) => {
    const requestId = payload?.requestId;
    if (typeof requestId !== "number") return;
    const resolve = pendingContextMenus.get(requestId);
    if (!resolve) return;
    pendingContextMenus.delete(requestId);
    resolve(typeof payload.id === "string" ? payload.id : null);
  },
);

contextBridge.exposeInMainWorld("resostageElectron", {
  isElectron: true,
  sendMenuState: (state: unknown) => ipcRenderer.send("menu-state", state),
  sendAction: (action: string) => ipcRenderer.send("action", action),
  flashAction: (action: string) => ipcRenderer.send("flash-action", action),
  /** Text field focused / blurred -- suppresses bare-key hotkeys in the shell. */
  setTypingFocus: (focused: boolean) =>
    ipcRenderer.send("typing-focus", focused),
  setKeyCaptureActive: (active: boolean) =>
    ipcRenderer.send("key-capture", active),
  /** Native OS context menu. Event-driven internally: the Promise is local to
   * the preload and never blocks on an ipcRenderer.invoke round trip. */
  showContextMenu: (
    items: unknown,
    x: number,
    y: number,
  ): Promise<string | null> => {
    const requestId = nextContextMenuRequestId++;
    return new Promise((resolve) => {
      pendingContextMenus.set(requestId, resolve);
      ipcRenderer.send("show-context-menu", { requestId, items, x, y });
    });
  },
  /** Trackpad haptic tick (Force Touch Taptic Engine). Fire-and-forget,
   * no-op on non-mac / non-Force-Touch hardware. */
  hapticFeedback: (pattern?: "generic" | "alignment" | "levelChange") =>
    ipcRenderer.send("haptic-feedback", pattern ?? "alignment"),
  /** Remote mode LAN discovery & connection */
  getDiscoveredDevices: () =>
    ipcRenderer.invoke("remote:get-discovered-devices"),
  getDiscoveryEnabled: () => ipcRenderer.invoke("remote:get-discovery-enabled"),
  setDiscoveryEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("remote:set-discovery-enabled", enabled),
  connectRemote: (host: string, port: number) =>
    ipcRenderer.invoke("remote:connect", { host, port }),
  disconnectRemote: () => ipcRenderer.invoke("remote:disconnect"),
  getRemoteStatus: () => ipcRenderer.invoke("remote:get-status"),
  /** Proxy HTTP request through Electron main process (avoids renderer network sandbox/CORS) */
  proxyRequest: (req: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
  }) => ipcRenderer.invoke("http:proxy", req),
  /** Floating Musical Typing / Virtual MIDI keyboard window management */
  toggleKeyboardWindow: () => ipcRenderer.invoke("keyboard-window:toggle"),
  openKeyboardWindow: () => ipcRenderer.invoke("keyboard-window:open"),
  closeKeyboardWindow: () => ipcRenderer.invoke("keyboard-window:close"),
  isKeyboardWindowOpen: () => ipcRenderer.invoke("keyboard-window:is-open"),
});

type BridgeGlobal = typeof globalThis & {
  dispatchEvent: (e: Event) => boolean;
  CustomEvent: new (type: string, init?: { detail?: unknown }) => Event;
};

function emit(type: string, detail?: unknown): void {
  try {
    const w = globalThis as BridgeGlobal;
    w.dispatchEvent(new w.CustomEvent(type, { detail }));
  } catch {
    /* ignore */
  }
}

// Shell → SPA: wake after sleep / minimize. IPC is more reliable than
// executeJavaScript after the GPU process has been suspended.
ipcRenderer.on("shell-resume", (_event, detail: { reason?: string }) => {
  emit("resoshell-resume", detail ?? { reason: "shell" });
});

// Shell → SPA: the idle policy (see main.mts). "idle" means the window is
// genuinely not on screen AND the transport is stopped, so the page can stand
// its animation loops down; "active" is sent the instant either stops being
// true, before the window is even shown, so the UI is already caught up by the
// time it is visible.
ipcRenderer.on("shell-idle", (_event, detail: { reason?: string }) => {
  emit("resoshell-idle", detail ?? { reason: "shell" });
});
ipcRenderer.on("shell-active", (_event, detail: { reason?: string }) => {
  emit("resoshell-active", detail ?? { reason: "shell" });
});

// Keep the renderer alive when the supervised Core exits so the SPA can show
// diagnostics instead of disappearing with its backend.
ipcRenderer.on("core-process-exit", (_event, detail: unknown) => {
  emit("resostage-core-process-exit", detail);
});

// Native-window shortcut capture is forwarded into the same typed renderer
// HotkeyManager used by browser events and editor-local command registrations.
ipcRenderer.on("dispatch-hotkey", (_event, detail: { action?: string }) => {
  if (typeof detail?.action === "string")
    emit("resostage-hotkey", { action: detail.action });
});

// Shell → SPA: battery / Low Power Mode / thermal pressure. The renderer has
// no way to see any of this itself; it feeds the frame-budget ladder.
ipcRenderer.on("shell-power", (_event, detail: unknown) => {
  emit("resoshell-power", detail);
});

// Shell → SPA: High-speed UDP telemetry binary packets (meters, peaks, lights)
ipcRenderer.on("udp-telemetry", (_event, buffer: unknown) => {
  emit("resostage-udp-telemetry", buffer);
});

// Native File menu -> the single React render dialog. The shell only conveys
// user intent; Core still validates and runs the authoritative render job.
ipcRenderer.on("open-audio-render", (_event, detail: unknown) => {
  emit("resostage-open-audio-render", detail);
});
ipcRenderer.on("open-midi-export", (_event, detail: unknown) => {
  emit("resostage-open-midi-export", detail);
});
ipcRenderer.on("open-midi-import", () => {
  emit("resostage-open-midi-import");
});
ipcRenderer.on("open-audio-import", () => {
  emit("resostage-open-audio-import");
});

// Floating Musical Typing window open/close state sync
ipcRenderer.on("keyboard-window:state-changed", (_event, isOpen: boolean) => {
  emit("resostage-keyboard-state-changed", isOpen);
});
