// contextBridge API exposed to the SPA as window.resostageElectron.
//
// Must stay CommonJS (.cts → .cjs): the renderer runs sandboxed, and
// sandboxed preload scripts cannot use ES module imports.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("resostageElectron", {
  isElectron: true,
  sendMenuState: (state: unknown) => ipcRenderer.send("menu-state", state),
  sendAction: (action: string) => ipcRenderer.send("action", action),
  /** Native OS context menu. Resolves to selected item id, or null if dismissed. */
  showContextMenu: (
    items: unknown,
    x: number,
    y: number,
  ): Promise<string | null> =>
    ipcRenderer.invoke("show-context-menu", { items, x, y }),
  /** Trackpad haptic tick (Force Touch Taptic Engine). Fire-and-forget,
   * no-op on non-mac / non-Force-Touch hardware. */
  hapticFeedback: (pattern?: "generic" | "alignment" | "levelChange") =>
    ipcRenderer.send("haptic-feedback", pattern ?? "alignment"),
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
