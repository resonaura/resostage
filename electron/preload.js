// contextBridge API exposed to the SPA as window.resostageElectron.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("resostageElectron", {
  isElectron: true,
  sendMenuState: (state) => ipcRenderer.send("menu-state", state),
  sendAction: (action) => ipcRenderer.send("action", action),
  /** Native OS context menu. Returns selected item id or null if dismissed. */
  showContextMenu: (items, x, y) =>
    ipcRenderer.invoke("show-context-menu", { items, x, y }),
});
