import { useEffect, useRef, useState } from "react";
import { wsUrl } from "./backend";
import { emptyState, type WebUiState } from "./types";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

export function useLiveState() {
  const [state, setState] = useState<WebUiState>(emptyState);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [cpuHistory, setCpuHistory] = useState<number[]>(() => Array(30).fill(0));
  const [ramHistory, setRamHistory] = useState<number[]>(() => Array(30).fill(0));

  const reconnectMsRef = useRef(500);
  const latestHealthRef = useRef<{ cpu: number; ram: number }>({ cpu: 0, ram: 0 });

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
          const parsed = JSON.parse(ev.data) as WebUiState;
          setState(parsed);

          if (parsed.health) {
            const cores =
              typeof navigator !== "undefined" && navigator.hardwareConcurrency
                ? navigator.hardwareConcurrency
                : 10;
            const targetCpu = Math.min(100, Math.max(0, (parsed.health.cpuPercent ?? 0) / cores));
            const targetRam = (parsed.health.rssBytes ?? 0) / (1024 * 1024);
            latestHealthRef.current = { cpu: targetCpu, ram: targetRam };
          }
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

    // Sample history ring buffer every 1000ms (1 second)
    const sampleInterval = setInterval(() => {
      setCpuHistory((prev) => [...prev.slice(1), latestHealthRef.current.cpu]);
      setRamHistory((prev) => [...prev.slice(1), latestHealthRef.current.ram]);
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(sampleInterval);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { state, status, cpuHistory, ramHistory };
}
