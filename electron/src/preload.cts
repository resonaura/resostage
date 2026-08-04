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

// Shell → SPA: wake after sleep / minimize. IPC is more reliable than
// executeJavaScript after the GPU process has been suspended.
ipcRenderer.on("shell-resume", (_event, detail: { reason?: string }) => {
  try {
    const w = globalThis as unknown as {
      dispatchEvent: (e: Event) => boolean;
      CustomEvent: new (type: string, init?: { detail?: unknown }) => Event;
    };
    w.dispatchEvent(
      new w.CustomEvent("resoshell-resume", {
        detail: detail ?? { reason: "shell" },
      }),
    );
  } catch {
    /* ignore */
  }
});
