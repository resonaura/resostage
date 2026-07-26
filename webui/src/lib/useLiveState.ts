import { useEffect, useRef, useState } from "react";
import { wsUrl } from "./backend";
import { emptyState, type WebUiState } from "./types";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

export function useLiveState() {
  const [state, setState] = useState<WebUiState>(emptyState);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const reconnectMsRef = useRef(500);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(wsUrl(), "resoset");

      ws.onopen = () => {
        reconnectMsRef.current = 500;
        setStatus("live");
      };
      ws.onmessage = (ev) => {
        try {
          setState(JSON.parse(ev.data) as WebUiState);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          // no-op
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        setStatus("reconnecting");
        reconnectTimer = setTimeout(connect, reconnectMsRef.current);
        reconnectMsRef.current = Math.min(reconnectMsRef.current * 1.5, 4000);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { state, status };
}
