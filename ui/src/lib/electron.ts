// True when this page is running inside the ResoStage Electron shell
// (electron/ in the repo root) rather than the JUCE-embedded WKWebView or a
// plain browser tab. The preload script (electron/preload.js) injects
// window.resostageElectron via contextBridge.
export const IS_ELECTRON: boolean =
  typeof window !== "undefined" &&
  (window as unknown as { resostageElectron?: { isElectron?: boolean } })
    .resostageElectron?.isElectron === true;
