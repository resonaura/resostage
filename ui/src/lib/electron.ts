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
      connectRemote?: (host: string, port: number) => Promise<{ ok: boolean; url?: string; error?: string }>;
      disconnectRemote?: () => Promise<boolean | { ok: boolean; url?: string }>;
      getRemoteStatus?: () => Promise<{
        isRemoteMode: boolean;
        activeRemoteHost?: string | null;
        controlReachable?: boolean;
        telemetry?: {
          state: "waiting" | "live" | "stale";
          localPort: number;
          source: string | null;
          receivedPackets: number;
          lostPackets: number;
          outOfOrderPackets: number;
          malformedPackets: number;
          receivedBytes: number;
          lastPacketAt: number | null;
          jitterMs: number;
        };
      }>;
      proxyRequest?: (req: {
        path: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | null;
      }) => Promise<{
        ok: boolean;
        status: number;
        statusText?: string;
        headers: Record<string, string>;
        data: unknown;
        isJson: boolean;
        error?: string;
      }>;
    };
  }
}

export const IS_ELECTRON: boolean =
  typeof window !== "undefined" &&
  window.resostageElectron?.isElectron === true;
