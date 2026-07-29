import { useEffect, useRef, useState } from "react";
import { wsUrl } from "./backend";
import { emptyState, type WebUiState } from "./types";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

/**
 * Merge a partial WS snapshot into the previous state. The server only
 * includes arrays relevant to the active SPA tab (see WebServer::
 * buildStateJson(view)); omitted keys keep their previous values so tab
 * switches don't blank out the UI before the next full-for-view frame.
 */
function mergeState(prev: WebUiState, next: Partial<WebUiState>): WebUiState {
  return {
    ...prev,
    ...next,
    songs: next.songs ?? prev.songs,
    meters: next.meters ?? prev.meters,
    tracks: next.tracks ?? prev.tracks,
    busses: next.busses ?? prev.busses,
    health: next.health
      ? {
          ...prev.health,
          ...next.health,
          processes: next.health.processes ?? prev.health.processes ?? [],
        }
      : prev.health,
    settings: next.settings
      ? {
          ...prev.settings,
          ...next.settings,
          // Don't wipe device lists when the server sent a keybindings-only stub.
          outputDevices: next.settings.outputDevices?.length
            ? next.settings.outputDevices
            : prev.settings.outputDevices,
          availableSampleRates: next.settings.availableSampleRates?.length
            ? next.settings.availableSampleRates
            : prev.settings.availableSampleRates,
          availableBufferSizes: next.settings.availableBufferSizes?.length
            ? next.settings.availableBufferSizes
            : prev.settings.availableBufferSizes,
          outputChannelNames: next.settings.outputChannelNames?.length
            ? next.settings.outputChannelNames
            : prev.settings.outputChannelNames,
          activeOutputChannels: next.settings.activeOutputChannels?.length
            ? next.settings.activeOutputChannels
            : prev.settings.activeOutputChannels,
          midiOutputs: next.settings.midiOutputs?.length
            ? next.settings.midiOutputs
            : prev.settings.midiOutputs,
          midiInputs: next.settings.midiInputs?.length
            ? next.settings.midiInputs
            : prev.settings.midiInputs,
          keybindings: next.settings.keybindings ?? prev.settings.keybindings,
          midiBindings:
            next.settings.midiBindings ?? prev.settings.midiBindings,
        }
      : prev.settings,
  };
}

export function useLiveState(view: string = "player") {
  const [state, setState] = useState<WebUiState>(emptyState);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [cpuHistory, setCpuHistory] = useState<number[]>(() =>
    Array(30).fill(0),
  );
  const [ramHistory, setRamHistory] = useState<number[]>(() =>
    Array(30).fill(0),
  );

  const reconnectMsRef = useRef(500);
  const latestHealthRef = useRef<{ cpu: number; ram: number }>({
    cpu: 0,
    ram: 0,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Tell the server which tab is active so it can filter the telemetry.
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ view }));
      } catch {
        // ignore
      }
    }
  }, [view]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(wsUrl(), "resoset");
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectMsRef.current = 500;
        setStatus("live");
        // Scope immediately so the first frames aren't the full dump.
        try {
          ws?.send(JSON.stringify({ view: viewRef.current }));
        } catch {
          // ignore
        }
      };
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as Partial<WebUiState>;
          setState((prev) => mergeState(prev, parsed));

          if (parsed.health) {
            const targetCpu = Math.max(0, parsed.health.cpuPercent ?? 0);
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
        wsRef.current = null;
        if (cancelled) return;
        setStatus("reconnecting");
        reconnectTimer = setTimeout(connect, reconnectMsRef.current);
        reconnectMsRef.current = Math.min(reconnectMsRef.current * 1.5, 4000);
      };
    };

    connect();

    const sampleInterval = setInterval(() => {
      setCpuHistory((prev) => [...prev.slice(1), latestHealthRef.current.cpu]);
      setRamHistory((prev) => [...prev.slice(1), latestHealthRef.current.ram]);
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(sampleInterval);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      wsRef.current = null;
    };
  }, []);

  return { state, status, cpuHistory, ramHistory };
}
