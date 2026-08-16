declare global {
  interface Window {
    resostageElectron?: {
      isElectron?: boolean;
      sendMenuState?: (state: unknown) => void;
      sendAction?: (action: string) => void;
      setTypingFocus?: (focused: boolean) => void;
      getDiscoveredDevices?: () => Promise<any[]>;
      connectRemote?: (host: string, port: number) => Promise<{ ok: boolean; url: string }>;
      disconnectRemote?: () => Promise<{ ok: boolean; url: string }>;
      getRemoteStatus?: () => Promise<{ isRemoteMode: boolean }>;
    };
  }
}

export const IS_ELECTRON: boolean =
  typeof window !== "undefined" &&
  window.resostageElectron?.isElectron === true;
