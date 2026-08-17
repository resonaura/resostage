declare global {
  interface Window {
    resostageElectron?: {
      isElectron?: boolean;
      sendMenuState?: (state: unknown) => void;
      sendAction?: (action: string) => void;
      setTypingFocus?: (focused: boolean) => void;
      getDiscoveredDevices?: () => Promise<any[]>;
      getDiscoveryEnabled?: () => Promise<boolean>;
      setDiscoveryEnabled?: (enabled: boolean) => Promise<boolean>;
      connectRemote?: (host: string, port: number) => Promise<boolean | { ok: boolean; url?: string }>;
      disconnectRemote?: () => Promise<boolean | { ok: boolean; url?: string }>;
      getRemoteStatus?: () => Promise<{ isRemoteMode: boolean; activeRemoteHost?: string | null }>;
    };
  }
}

export const IS_ELECTRON: boolean =
  typeof window !== "undefined" &&
  window.resostageElectron?.isElectron === true;
