import { useCallback, useEffect, useState } from "react";
import { getRemoteBackend, setRemoteBackend } from "../../lib/state/backend";
import { IS_ELECTRON } from "../../lib/platform/electron";

/** Tracks the shell's remote Core connection and provides the matching disconnect action. */
export function useRemoteBackend() {
  const [remoteHost, setRemoteHost] = useState<string | null>(() =>
    getRemoteBackend(),
  );

  useEffect(() => {
    const checkRemote = async () => {
      if (IS_ELECTRON && window.resostageElectron?.getRemoteStatus) {
        try {
          const status = await window.resostageElectron.getRemoteStatus();
          if (status?.isRemoteMode && status.activeRemoteHost) {
            setRemoteBackend(status.activeRemoteHost);
            setRemoteHost(status.activeRemoteHost);
            return;
          } else if (!status?.isRemoteMode) {
            setRemoteBackend(null);
            setRemoteHost(null);
            return;
          }
        } catch {}
      }
      setRemoteHost(getRemoteBackend());
    };
    void checkRemote();
    const interval = setInterval(checkRemote, 1000);
    return () => clearInterval(interval);
  }, []);

  const disconnect = useCallback(async () => {
    setRemoteBackend(null);
    setRemoteHost(null);
    if (IS_ELECTRON && window.resostageElectron?.disconnectRemote) {
      await window.resostageElectron.disconnectRemote();
    } else {
      window.location.href = "/";
    }
  }, []);

  return { remoteHost, disconnect };
}
