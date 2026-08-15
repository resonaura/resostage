// DEPRECATED shim — the real preload is electron/src/preload.cts → dist/preload.cjs
// (BrowserWindow loads dist/preload.cjs). Kept in sync so accidental loads
// still expose the full bridge.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("resostageElectron", {
  isElectron: true,
  sendMenuState: (state) => ipcRenderer.send("menu-state", state),
  sendAction: (action) => ipcRenderer.send("action", action),
  /** Native OS context menu. Returns selected item id or null if dismissed. */
  showContextMenu: (items, x, y) =>
    ipcRenderer.invoke("show-context-menu", { items, x, y }),
});

ipcRenderer.on("udp-telemetry", (_event, buffer) => {
  try {
    window.dispatchEvent(new CustomEvent("resostage-udp-telemetry", { detail: buffer }));
  } catch {}
});
