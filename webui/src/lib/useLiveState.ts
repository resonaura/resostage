import { useEffect, useRef, useState } from "react";
import { wsUrl } from "./backend";
import { pushLiveLevels } from "./liveLevels";
import { emptyState, type WebUiState } from "./types";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

/**
 * Merge a partial WS snapshot into the previous state. The server only
 * includes arrays relevant to the active SPA tab (see WebServer::
 * buildStateJson(view)); omitted keys keep their previous values so tab
 * switches don't blank out the UI before the next full-for-view frame.
 *
 * Meter peaks are NOT max-merged here — that would be fake hold. Live
 * levels go through pushLiveLevels() on every frame so ballistics see
 * the true signal including brief silence between metronome hits.
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

  // Structural state is rAF-coalesced (latest wins). Meter levels are pushed
  // on every frame into liveLevels so short impulses (metronome) are never
  // dropped by coalesce.
  const pendingRawRef = useRef<string | null>(null);
  const rafRef = useRef<number>(0);

  const flushPending = () => {
    rafRef.current = 0;
    const raw = pendingRawRef.current;
    pendingRawRef.current = null;
    if (raw == null) return;
    try {
      const parsed = JSON.parse(raw) as Partial<WebUiState>;
      setState((prev) => mergeState(prev, parsed));
      if (parsed.health) {
        latestHealthRef.current = {
          cpu: Math.max(0, parsed.health.cpuPercent ?? 0),
          ram: (parsed.health.rssBytes ?? 0) / (1024 * 1024),
        };
      }
    } catch {
      // ignore malformed
    }
  };

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
        try {
          ws?.send(JSON.stringify({ view: viewRef.current }));
        } catch {
          // ignore
        }
      };
      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        // 1) Levels: every frame, immediately (no drop).
        try {
          const parsed = JSON.parse(raw) as Partial<WebUiState>;
          pushLiveLevels({
            clickPeakDb: parsed.clickPeakDb,
            clickPeakDbL: parsed.clickPeakDbL,
            clickPeakDbR: parsed.clickPeakDbR,
            tracks: parsed.tracks,
            meters: parsed.meters,
          });
          if (parsed.health) {
            latestHealthRef.current = {
              cpu: Math.max(0, parsed.health.cpuPercent ?? 0),
              ram: (parsed.health.rssBytes ?? 0) / (1024 * 1024),
            };
          }
        } catch {
          // ignore
        }
        // 2) Full React state: coalesce to paint rate.
        pendingRawRef.current = raw;
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(flushPending);
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
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ws?.close();
      wsRef.current = null;
    };
  }, []);

  return { state, status, cpuHistory, ramHistory };
}
