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
});
